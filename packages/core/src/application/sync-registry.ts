import { Clock, Data, Effect, Option, Schema } from "effect"
import {
  type ComponentSnapshot,
  type Registry,
  type RegistryId,
  type UserId,
  type WireRegistryItem,
  WireRegistryItem as WireRegistryItemSchema,
  completeSync,
  failSync,
  isStaleSync,
  needsEnrichment,
  planSync,
  startSync,
  toComponentSnapshot,
} from "../domain/index.js"
import {
  ComponentRepository,
  ExplorerConfig,
  JobScheduler,
  RegistryFetchError,
  RegistryHttp,
  RegistryRepository,
  BlobStore,
  TextSearchIndex,
  VectorIndex,
} from "../ports/index.js"
import { NotRegistryOwner } from "./errors.js"
import { itemSourceKey } from "./keys.js"
import { fetchRegistryIndex } from "./resolve-registry.js"

export class RegistryNotFoundById extends Data.TaggedError("RegistryNotFoundById")<{
  readonly registryId: RegistryId
}> {}

export interface SyncReport {
  readonly registryId: RegistryId
  readonly added: number
  readonly changed: number
  readonly unchanged: number
  readonly removed: number
  readonly scheduledForEnrichment: number
  readonly warnings: ReadonlyArray<string>
}

/** インデックスに内容 (files[].content) が含まれていればアイテム JSON の取得を省略する */
const hasInlineContent = (item: WireRegistryItem) =>
  (item.files ?? []).length > 0 && (item.files ?? []).every((f) => typeof f.content === "string")

const fetchItem = (registry: Registry, indexItem: WireRegistryItem) =>
  Effect.gen(function* () {
    const url = registry.locator.itemUrl(indexItem.name)
    if (hasInlineContent(indexItem)) return { item: indexItem, url }
    const http = yield* RegistryHttp
    const json = yield* http.getJson(url)
    const item = yield* Schema.decodeUnknown(WireRegistryItemSchema)(json).pipe(
      Effect.mapError((e) => new RegistryFetchError({ url, reason: e.message.slice(0, 300) })),
    )
    return { item, url }
  })

const beginSync = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const repo = yield* RegistryRepository
    const { syncTimeoutMs } = yield* ExplorerConfig
    const now = yield* Clock.currentTimeMillis
    const registry = yield* repo.findById(registryId).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new RegistryNotFoundById({ registryId })),
        onSome: Effect.succeed,
      })),
    )
    // 前回の同期が異常終了して Syncing のまま残っていたら、一度 Failed に落としてから再開する
    const recovered = isStaleSync(registry, now, syncTimeoutMs)
      ? yield* failSync(registry, now, "同期がタイムアウトしました")
      : registry
    const syncing = yield* startSync(recovered, now)
    yield* repo.update(syncing)
    return syncing
  })

/**
 * レジストリ同期ユースケース。
 * 1. registry.json と各アイテムを取得
 * 2. contentHash で差分を取り、変更分だけ保存
 * 3. 削除されたアイテムを検索インデックスからも消す
 * 4. 新規・変更分のエンリッチメントをスケジュール
 */
export const syncRegistry = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const registryRepo = yield* RegistryRepository
    const componentRepo = yield* ComponentRepository
    const scheduler = yield* JobScheduler
    const textIndex = yield* TextSearchIndex
    const vectorIndex = yield* VectorIndex
    const blobs = yield* BlobStore
    const { budget } = yield* ExplorerConfig

    const registry = yield* beginSync(registryId)

    const body = Effect.gen(function* () {
      const index = yield* fetchRegistryIndex(registry.locator)
      const warnings: Array<string> = []
      if (index.items.length > budget.maxItemsPerRegistry) {
        warnings.push(`アイテム数 ${index.items.length} が上限 ${budget.maxItemsPerRegistry} を超えたため切り詰めました`)
      }
      const indexItems = index.items.slice(0, budget.maxItemsPerRegistry)

      const results = yield* Effect.forEach(
        indexItems,
        (indexItem) =>
          fetchItem(registry, indexItem).pipe(
            Effect.flatMap(({ item, url }) =>
              Effect.map(toComponentSnapshot(registry.id, item, url), (snapshot) => ({ snapshot, item })),
            ),
            Effect.either,
          ),
        { concurrency: 6 },
      )
      const snapshots: Array<ComponentSnapshot> = []
      const itemsById = new Map<string, WireRegistryItem>()
      for (const r of results) {
        if (r._tag === "Right") {
          snapshots.push(r.right.snapshot)
          itemsById.set(r.right.snapshot.id, r.right.item)
        } else warnings.push(`${r.left._tag}: ${"url" in r.left ? r.left.url : r.left.name} - ${r.left.reason}`)
      }
      if (indexItems.length > 0 && snapshots.length === 0) {
        return yield* new RegistryFetchError({
          url: registry.locator.indexUrl,
          reason: "全てのアイテムの取得に失敗しました",
        })
      }

      const plan = planSync(yield* componentRepo.hashesByRegistry(registry.id), snapshots)
      const toEnrich = needsEnrichment(plan)
      // 生成時に再取得しないよう、変更分の registry-item.json 原本を保存しておく
      yield* Effect.forEach(
        toEnrich,
        (snap) => blobs.put(itemSourceKey(snap.id, snap.contentHash), JSON.stringify(itemsById.get(snap.id)), "application/json"),
        { concurrency: 8, discard: true },
      )
      yield* componentRepo.upsertSnapshots(toEnrich)
      if (plan.removed.length > 0) {
        yield* componentRepo.remove(plan.removed)
        // インデックスの削除失敗は同期全体を失敗させない (次回同期で再試行される)
        yield* Effect.all([textIndex.remove(plan.removed), vectorIndex.remove(plan.removed)], {
          concurrency: 2,
          discard: true,
        }).pipe(Effect.catchAll((e) => Effect.sync(() => warnings.push(`index cleanup: ${e.reason}`))))
      }
      if (toEnrich.length > 0) yield* scheduler.scheduleEnrichment(toEnrich.map((s) => s.id))

      return {
        registryId: registry.id,
        added: plan.added.length,
        changed: plan.changed.length,
        unchanged: plan.unchanged.length,
        removed: plan.removed.length,
        scheduledForEnrichment: toEnrich.length,
        warnings,
        itemCount: snapshots.length,
      }
    })

    return yield* body.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const reason = "reason" in error ? String(error.reason) : error._tag
          const failed = yield* failSync(registry, now, reason)
          yield* registryRepo.update(failed)
        }).pipe(Effect.ignore),
      ),
      Effect.flatMap(({ itemCount, ...report }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* registryRepo.update(yield* completeSync(registry, now, itemCount))
          return report satisfies SyncReport
        }),
      ),
    )
  })

/** cron から呼ばれる: 同期可能な全レジストリの再同期を投入する (差分がなければ AI コストは発生しない) */
export const scheduleResyncAll = Effect.gen(function* () {
  const repo = yield* RegistryRepository
  const scheduler = yield* JobScheduler
  const { syncTimeoutMs } = yield* ExplorerConfig
  const now = yield* Clock.currentTimeMillis
  const targets = (yield* repo.list()).filter(
    (r) =>
      r.status._tag === "Active" ||
      r.status._tag === "Failed" ||
      r.status._tag === "Pending" ||
      isStaleSync(r, now, syncTimeoutMs),
  )
  yield* Effect.forEach(targets, (r) => scheduler.scheduleSync(r.id), { discard: true })
  return targets.length
})


/** 手動の再同期要求。登録者 (または所有者なしの公開レジストリ) のみ許可する */
export const requestResync = (registryId: RegistryId, requester: UserId) =>
  Effect.gen(function* () {
    const repo = yield* RegistryRepository
    const scheduler = yield* JobScheduler
    const registry = yield* repo.findById(registryId)
    if (Option.isNone(registry)) return yield* new RegistryNotFoundById({ registryId })
    if (registry.value.ownerId !== null && registry.value.ownerId !== requester) {
      return yield* new NotRegistryOwner({ registryId })
    }
    yield* scheduler.scheduleSync(registryId)
  })

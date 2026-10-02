import { Clock, Effect, Option, Schema } from "effect"
import {
  ComponentId,
  type ComponentSnapshot,
  type ThemeCandidate,
  type Registry,
  type RegistryId,
  type WireRegistryItem,
  WireRegistryItem as WireRegistryItemSchema,
  completeSync,
  failSync,
  isResyncDue,
  oneLine,
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
import { RegistryNotFoundById } from "./errors.js"
import { describeTheme, emit } from "./pipeline-log.js"
import { itemSourceKey } from "./keys.js"
import { resolveThemeOnSync } from "./registry-theme.js"
import { fetchRegistryIndex } from "./resolve-registry.js"

export { RegistryNotFoundById } from "./errors.js"

export interface SyncReport {
  readonly registryId: RegistryId
  readonly added: number
  readonly changed: number
  readonly unchanged: number
  readonly removed: number
  readonly scheduledForEnrichment: number
  readonly warnings: ReadonlyArray<string>
  /** テーマが registry.json で決まらず、エージェントにインストール手順を読ませる必要がある (SyncRegistryWorkflow が続けて回す) */
  readonly themeAgent: boolean
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
 * 4. テーマを判定する (registry.json のテーマ系アイテム。決まらなければエージェントへ)。エンリッチより先に決める
 *    (決まる前にプレビューを作ると作り直しになる)
 * 5. 新規・変更分のエンリッチメントをスケジュール
 */
export const syncRegistry = (registryId: RegistryId, options: { readonly forceTheme?: boolean } = {}) =>
  Effect.gen(function* () {
    const registryRepo = yield* RegistryRepository
    const componentRepo = yield* ComponentRepository
    const scheduler = yield* JobScheduler
    const textIndex = yield* TextSearchIndex
    const vectorIndex = yield* VectorIndex
    const blobs = yield* BlobStore
    const { budget } = yield* ExplorerConfig

    const registry = yield* beginSync(registryId)
    yield* emit({ registryId, componentId: null, stage: "sync", status: "start", message: `Reading ${registry.locator.indexUrl}` })

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
      const themeCandidates: Array<ThemeCandidate> = []
      // 取得に失敗したアイテムは「index から消えた」わけではない。削除扱いにすると、次の同期で新規として全額払い直すことになる
      const unreachable = new Set<ComponentId>()
      for (const [i, r] of results.entries()) {
        if (r._tag === "Right") {
          snapshots.push(r.right.snapshot)
          itemsById.set(r.right.snapshot.id, r.right.item)
          themeCandidates.push({ item: r.right.item, url: r.right.snapshot.sourceUrl })
        } else {
          unreachable.add(ComponentId.make(`${registry.id}:${indexItems[i]!.name}`))
          warnings.push(`${r.left._tag}: ${"url" in r.left ? r.left.url : r.left.name} - ${r.left.reason}`)
        }
      }
      if (indexItems.length > 0 && snapshots.length === 0) {
        return yield* new RegistryFetchError({
          url: registry.locator.indexUrl,
          reason: "全てのアイテムの取得に失敗しました",
        })
      }

      const synced = planSync(yield* componentRepo.hashesByRegistry(registry.id), snapshots)
      const plan = { ...synced, removed: synced.removed.filter((id) => !unreachable.has(id)) }
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
      const theme = yield* resolveThemeOnSync(registry.id, themeCandidates, { force: options.forceTheme === true }).pipe(
        Effect.catchAll((e) =>
          e._tag === "PersistenceError"
            ? Effect.fail(e)
            : Effect.sync(() => {
                warnings.push(`theme: ${e._tag}`)
                return { needsAgent: false }
              }),
        ),
      )
      if ("theme" in theme && JSON.stringify(theme.theme) !== JSON.stringify(registry.theme)) {
        yield* emit({ registryId, componentId: null, stage: "theme", status: theme.theme._tag === "Failed" ? "warn" : "ok", message: describeTheme(theme.theme) })
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
        themeAgent: theme.needsAgent,
        itemCount: snapshots.length,
      }
    })

    return yield* body.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const reason = "reason" in error ? String(error.reason) : error._tag
          // テーマの判定が設定を更新しているので読み直してから遷移する
          const latest = Option.getOrElse(yield* registryRepo.findById(registry.id), () => registry)
          const failed = yield* failSync(latest, now, reason)
          yield* registryRepo.update(failed)
          yield* emit({ registryId, componentId: null, stage: "sync", status: "error", message: `Sync failed: ${oneLine(reason)}` })
        }).pipe(Effect.ignore),
      ),
      Effect.flatMap(({ itemCount, ...report }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const latest = Option.getOrElse(yield* registryRepo.findById(registry.id), () => registry)
          yield* registryRepo.update(yield* completeSync(latest, now, itemCount))
          const changes = report.added + report.changed + report.removed
          yield* emit({
            registryId,
            componentId: null,
            stage: "sync",
            status: "ok",
            message:
              changes === 0
                ? `Synced ${itemCount} items · nothing changed`
                : `Synced ${itemCount} items · ${report.added} new, ${report.changed} changed, ${report.removed} removed`,
            detail: { items: itemCount, added: report.added, changed: report.changed, removed: report.removed },
          })
          return report satisfies SyncReport
        }),
      ),
    )
  })

/**
 * cron (日次) から呼ばれる: 前回の同期から間隔 (7 日) が過ぎたレジストリの再同期を投入する。
 * 古い順に resyncPerRun 件まで (公式ディレクトリを全部取り込むと 300 以上になるので、夜ごとに分散させる)。
 * 未同期 (Pending)・失敗・詰まった同期は間隔を待たずに投入する。差分がなければ AI コストは発生しない
 */
export const scheduleResyncAll = Effect.gen(function* () {
  const repo = yield* RegistryRepository
  const scheduler = yield* JobScheduler
  const { syncTimeoutMs, lifecycle } = yield* ExplorerConfig
  const now = yield* Clock.currentTimeMillis
  const lastSynced = (r: Registry) =>
    r.status._tag === "Active" || r.status._tag === "Failed" || r.status._tag === "Syncing" ? r.status.lastSyncedAt : null
  const targets = (yield* repo.list())
    .filter(
      (r) =>
        r.status._tag === "Pending" ||
        isStaleSync(r, now, syncTimeoutMs) ||
        ((r.status._tag === "Active" || r.status._tag === "Failed") && isResyncDue(lastSynced(r), now, lifecycle.resyncIntervalMs)),
    )
    .sort((a, b) => (lastSynced(a) ?? 0) - (lastSynced(b) ?? 0))
    .slice(0, lifecycle.resyncPerRun)
  yield* Effect.forEach(targets, (r) => scheduler.scheduleSync(r.id), { discard: true })
  return targets.length
})

/** 手動の再同期要求。誰に許すか (現在は運営者のみ) は呼び出し側 (presentation) が決める */
export const requestResync = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const repo = yield* RegistryRepository
    const scheduler = yield* JobScheduler
    const registry = yield* repo.findById(registryId)
    if (Option.isNone(registry)) return yield* new RegistryNotFoundById({ registryId })
    yield* scheduler.scheduleSync(registryId)
  })

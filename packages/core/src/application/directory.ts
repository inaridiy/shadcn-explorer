import { Clock, Effect, Option } from "effect"
import {
  type DirectoryEntry,
  type WireDirectoryEntry,
  type Registry as RegistryType,
  Registry,
  mergeDirectoryEntry,
  planDirectoryIntake,
  sameItemTemplate,
} from "../domain/index.js"
import { ComponentRepository, DirectoryRepository, ExplorerConfig, JobScheduler, RegistryRepository } from "../ports/index.js"
import { registerRegistry } from "./register-registry.js"
import { fetchDirectoryFresh } from "./resolve-registry.js"

/**
 * 公式ディレクトリのライフサイクル (v0.7)。
 *   cron (日次) → syncDirectory: ディレクトリの写しを更新し、既存のレジストリの出自 (Official / 掲載落ち) を直す
 *              → intakeDirectory: エンリッチの backlog が空いていれば、ranking の高い順に N 件だけ登録する
 * 登録したレジストリは通常どおり同期 → エンリッチに流れる。取り込みの失敗は Skipped として残し、毎日は試さない
 */

const matchRegistry = (entry: DirectoryEntry, registries: ReadonlyArray<RegistryType>) =>
  registries.find(
    (r) =>
      sameItemTemplate(r.locator.itemUrlTemplate, entry.url) ||
      (r.namespace !== null && r.namespace.toLowerCase() === entry.name.toLowerCase()),
  )

export interface DirectorySyncReport {
  readonly listed: number
  readonly added: number
  readonly delisted: number
  readonly relabeled: number
}

/** ディレクトリを取得して写しを更新し、既存のレジストリの出自を合わせる */
export const syncDirectory = Effect.flatMap(fetchDirectoryFresh, (wire) => syncDirectoryWith(wire))

/** 取得済みのディレクトリで同期する (PC での一括取り込みで、ワーカーからの取得が断られたときにホストで取ったものを渡す) */
export const syncDirectoryWith = (wire: ReadonlyArray<WireDirectoryEntry>) => Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  const directory = yield* DirectoryRepository
  const registryRepo = yield* RegistryRepository
  const previous = new Map((yield* directory.list()).map((e) => [e.name, e]))
  const registries = yield* registryRepo.list()

  const current = wire.map((w) => mergeDirectoryEntry(previous.get(w.name), w, now))
  const names = new Set(current.map((e) => e.name))
  const delisted = [...previous.values()]
    .filter((e) => !names.has(e.name) && e.state !== "Delisted")
    .map((e): DirectoryEntry => ({ ...e, state: "Delisted", checkedAt: now }))

  // 既存のレジストリと突き合わせる (手で登録したものが実は公式だった、も拾う)
  let relabeled = 0
  const linked = yield* Effect.forEach(current, (entry) =>
    Effect.gen(function* () {
      const registry = matchRegistry(entry, registries)
      if (!registry) return entry
      const listing = registry.listing
      if (!(listing._tag === "Official" && listing.listed && listing.directoryName === entry.name)) {
        yield* registryRepo.update(new Registry({ ...registry, listing: { _tag: "Official", directoryName: entry.name, listed: true } }))
        relabeled++
      }
      return { ...entry, state: "Imported" as const, registryId: registry.id, skipReason: null }
    }),
  )
  // 掲載が外れた公式レジストリは残す (同期も続ける) が、Official のバッジは外す
  for (const registry of registries) {
    if (registry.listing._tag !== "Official" || !registry.listing.listed) continue
    const stillListed = linked.some((e) => e.registryId === registry.id)
    if (!stillListed) {
      yield* registryRepo.update(new Registry({ ...registry, listing: { ...registry.listing, listed: false } }))
      relabeled++
    }
  }

  yield* directory.upsert([...linked, ...delisted])
  return {
    listed: current.length,
    added: current.filter((e) => !previous.has(e.name)).length,
    delisted: delisted.length,
    relabeled,
  } satisfies DirectorySyncReport
})

export interface IntakeReport {
  readonly imported: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<string>
  readonly failed: ReadonlyArray<string>
  /** backlog が多くて取り込まなかった */
  readonly deferred: boolean
}

/** エラーの種類から「二度と試さない」か「後で試す」かを決める */
const permanentReason = (error: { readonly _tag: string }): string | null => {
  switch (error._tag) {
    case "RegistryTooLarge":
      return "too large"
    case "RegistryEmpty":
      return "registry.json has no items"
    case "RegistryNotFound":
    case "NamespaceNotFound":
      return "registry.json not found"
    case "InvalidRegistryInput":
      return "invalid URL"
    default:
      return null
  }
}

/** 公式レジストリを ranking の高い順に N 件取り込む (エンリッチが詰まっていれば何もしない) */
export const intakeDirectory = Effect.gen(function* () {
  const { lifecycle, budget, enrichment } = yield* ExplorerConfig
  const directory = yield* DirectoryRepository
  const empty: IntakeReport = { imported: [], skipped: [], failed: [], deferred: false }
  if (!lifecycle.directoryIntake) return empty
  // キューに積まれた数と、まだ終わっていない数 (無料枠待ちで翌日に回ったものはキューから消えるので、こちらで数える) の大きい方
  const queued = yield* (yield* JobScheduler).pendingEnrichments().pipe(Effect.orElseSucceed(() => 0))
  const unfinished = yield* (yield* ComponentRepository).countUnfinished()
  if (Math.max(queued, unfinished) > lifecycle.maxBacklog) return { ...empty, deferred: true }

  const plan = planDirectoryIntake(yield* directory.list(), {
    maxItems: budget.maxItemsPerRegistry,
    maxAttempts: enrichment.maxAttempts,
    limit: lifecycle.intakePerRun,
  })
  const now = yield* Clock.currentTimeMillis
  const updates: Array<DirectoryEntry> = plan.skip.map(({ entry, reason }) => ({
    ...entry,
    state: "Skipped",
    skipReason: reason,
    checkedAt: now,
  }))
  const imported: Array<string> = []
  const failed: Array<string> = []
  for (const entry of plan.importNow) {
    const result = yield* Effect.either(registerRegistry(entry.name, null))
    if (result._tag === "Right") {
      imported.push(entry.name)
      updates.push({ ...entry, state: "Imported", registryId: result.right.id, checkedAt: now })
      continue
    }
    const error = result.left
    if (error._tag === "RegistryAlreadyRegistered") {
      updates.push({ ...entry, state: "Imported", registryId: error.registryId, checkedAt: now })
      continue
    }
    const reason = permanentReason(error)
    if (reason) {
      updates.push({ ...entry, state: "Skipped", skipReason: reason, checkedAt: now })
    } else {
      failed.push(entry.name)
      updates.push({ ...entry, attempts: entry.attempts + 1, skipReason: `${error._tag}`, checkedAt: now })
    }
  }
  yield* directory.upsert(updates)
  return { imported, skipped: plan.skip.map((s) => s.entry.name), failed, deferred: false } satisfies IntakeReport
})

/** 管理画面: 公式ディレクトリの取り込み状況 */
export const directoryStatus = Effect.gen(function* () {
  const entries = yield* (yield* DirectoryRepository).list()
  const count = (state: DirectoryEntry["state"]) => entries.filter((e) => e.state === state).length
  return {
    entries,
    counts: { New: count("New"), Imported: count("Imported"), Skipped: count("Skipped"), Delisted: count("Delisted") },
  }
})

/** Skipped にしたものを New に戻す (運営者が上限を変えたときなど) */
export const retryDirectoryEntry = (name: string) =>
  Effect.gen(function* () {
    const directory = yield* DirectoryRepository
    const entry = (yield* directory.list()).find((e) => e.name === name)
    if (!entry || entry.state !== "Skipped") return Option.none<DirectoryEntry>()
    const reset: DirectoryEntry = { ...entry, state: "New", skipReason: null, attempts: 0 }
    yield* directory.upsert([reset])
    return Option.some(reset)
  })

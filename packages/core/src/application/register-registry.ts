import { Clock, Data, Effect, Option } from "effect"
import {
  EnrichmentState,
  type MicroUsd,
  Registry,
  RegistryId,
  type UserId,
  estimatePlanCost,
  kindFromWire,
  planEnrichment,
  slugifyRegistryName,
  toUsd,
} from "../domain/index.js"
import { ExplorerConfig, JobScheduler, RegistryRepository } from "../ports/index.js"
import { type ResolvedRegistry, resolveRegistry } from "./resolve-registry.js"

export class RegistryAlreadyRegistered extends Data.TaggedError("RegistryAlreadyRegistered")<{
  readonly registryId: RegistryId
}> {}

export class RegistryTooLarge extends Data.TaggedError("RegistryTooLarge")<{
  readonly itemCount: number
  readonly limit: number
}> {}

export class RegistryEmpty extends Data.TaggedError("RegistryEmpty")<{}> {}

/** 登録前の確認画面に出す情報。コスト見積もりもここで出す。 */
export interface RegistrationPreview {
  readonly name: string
  readonly homepage: string | null
  readonly namespace: string | null
  readonly indexUrl: string
  readonly itemUrlTemplate: string
  readonly itemCount: number
  readonly kinds: Readonly<Record<string, number>>
  readonly sampleItems: ReadonlyArray<{ readonly name: string; readonly type: string; readonly description: string }>
  readonly estimatedInitialCostUsd: number
  readonly directoryHealth: string | null
  readonly alreadyRegistered: RegistryId | null
  readonly tooLarge: boolean
}

const estimateInitialCost = (resolved: ResolvedRegistry) =>
  Effect.gen(function* () {
    const { prices, enrichment } = yield* ExplorerConfig
    return resolved.index.items.reduce(
      (sum, item) =>
        sum +
        estimatePlanCost(
          planEnrichment({ kind: kindFromWire(item.type), contentHash: "" }, EnrichmentState.initial, enrichment),
          prices,
        ),
      0,
    ) as MicroUsd
  })

const summarize = (resolved: ResolvedRegistry) =>
  Effect.gen(function* () {
    const repo = yield* RegistryRepository
    const { budget } = yield* ExplorerConfig
    const existing = yield* repo.findByIndexUrl(resolved.locator.indexUrl)
    const kinds: Record<string, number> = {}
    for (const item of resolved.index.items) {
      const k = kindFromWire(item.type)
      kinds[k] = (kinds[k] ?? 0) + 1
    }
    const cost = yield* estimateInitialCost(resolved)
    return {
      name: resolved.index.name,
      homepage: resolved.index.homepage ?? null,
      namespace: resolved.namespace,
      indexUrl: resolved.locator.indexUrl,
      itemUrlTemplate: resolved.locator.itemUrlTemplate,
      itemCount: resolved.index.items.length,
      kinds,
      sampleItems: resolved.index.items.slice(0, 8).map((i) => ({
        name: i.name,
        type: i.type,
        description: i.description ?? "",
      })),
      estimatedInitialCostUsd: toUsd(cost),
      directoryHealth: Option.getOrNull(
        Option.flatMap(resolved.directoryEntry, (e) => Option.fromNullable(e.health?.status)),
      ),
      alreadyRegistered: Option.getOrNull(Option.map(existing, (r) => r.id)),
      tooLarge: resolved.index.items.length > budget.maxItemsPerRegistry,
    } satisfies RegistrationPreview
  })

/** 登録フロー Step 1: 入力を解決して確認情報を返す (副作用なし) */
export const previewRegistration = (input: string) => resolveRegistry(input).pipe(Effect.flatMap(summarize))

const allocateRegistryId = (name: string) =>
  Effect.gen(function* () {
    const repo = yield* RegistryRepository
    const base = slugifyRegistryName(name)
    for (let i = 1; i <= 50; i++) {
      const candidate = RegistryId.make(i === 1 ? base : `${base}-${i}`)
      const found = yield* repo.findById(candidate)
      if (Option.isNone(found)) return candidate
    }
    return RegistryId.make(`${base}-${crypto.randomUUID().slice(0, 8)}`)
  })

/**
 * 登録フロー Step 2: 登録して初回同期をスケジュールする。
 * 同じ registry.json の二重登録と、上限を超える巨大レジストリは拒否する。
 */
export const registerRegistry = (input: string, ownerId: UserId | null) =>
  Effect.gen(function* () {
    const repo = yield* RegistryRepository
    const scheduler = yield* JobScheduler
    const { budget } = yield* ExplorerConfig

    const resolved = yield* resolveRegistry(input)
    const existing = yield* repo.findByIndexUrl(resolved.locator.indexUrl)
    if (Option.isSome(existing)) return yield* new RegistryAlreadyRegistered({ registryId: existing.value.id })
    if (resolved.index.items.length === 0) return yield* new RegistryEmpty()
    if (resolved.index.items.length > budget.maxItemsPerRegistry) {
      return yield* new RegistryTooLarge({
        itemCount: resolved.index.items.length,
        limit: budget.maxItemsPerRegistry,
      })
    }

    const now = yield* Clock.currentTimeMillis
    const registry = new Registry({
      id: yield* allocateRegistryId(resolved.namespace ?? resolved.index.name),
      name: resolved.index.name,
      homepage: resolved.index.homepage ?? null,
      namespace: resolved.namespace,
      locator: resolved.locator,
      ownerId,
      status: { _tag: "Pending" },
      createdAt: now,
    })
    yield* repo.insert(registry)
    yield* scheduler.scheduleSync(registry.id)
    return registry
  })

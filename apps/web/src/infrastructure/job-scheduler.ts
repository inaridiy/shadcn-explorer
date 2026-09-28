import { Effect, Layer } from "effect"
import type { ComponentId, RegistryId } from "@shadcn-explorer/core/domain"
import { JobScheduler, SchedulerError } from "@shadcn-explorer/core/ports"

export interface SyncParams {
  readonly registryId: RegistryId
}
export interface EnrichParams {
  readonly componentIds: ReadonlyArray<ComponentId>
}

const shortId = () => crypto.randomUUID().slice(0, 8)

/**
 * Cloudflare Workflows でジョブを投入する。
 * エンリッチは ENRICH_PARALLELISM 本のバッチ Workflow に分割し、Agent / Browser の同時実行数 (= コストの瞬間最大) を抑える。
 */
export const WorkflowJobScheduler = (env: Env) => {
  const parallelism = Math.max(1, Number(env.ENRICH_PARALLELISM) || 4)
  return Layer.succeed(JobScheduler, {
    scheduleSync: (registryId) =>
      Effect.tryPromise({
        try: () =>
          env.SYNC_WORKFLOW.create({ id: `sync-${registryId}-${shortId()}`.slice(0, 64), params: { registryId } satisfies SyncParams }),
        catch: (e) => new SchedulerError({ reason: String(e) }),
      }).pipe(Effect.asVoid),
    scheduleEnrichment: (ids) => {
      if (ids.length === 0) return Effect.void
      const size = Math.ceil(ids.length / parallelism)
      const batches: Array<ReadonlyArray<ComponentId>> = []
      for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size))
      return Effect.tryPromise({
        try: () =>
          env.ENRICH_WORKFLOW.createBatch(
            batches.map((componentIds) => ({ id: `enrich-${shortId()}-${shortId()}`, params: { componentIds } satisfies EnrichParams })),
          ),
        catch: (e) => new SchedulerError({ reason: String(e) }),
      }).pipe(Effect.asVoid)
    },
  })
}

export type InlineJob =
  | { readonly _tag: "Sync"; readonly registryId: RegistryId }
  | { readonly _tag: "Enrich"; readonly componentIds: ReadonlyArray<ComponentId> }

/** ローカル開発用: waitUntil でリクエスト後にその場で実行する */
export const InlineJobScheduler = (dispatch: (job: InlineJob) => void) =>
  Layer.succeed(JobScheduler, {
    scheduleSync: (registryId) => Effect.sync(() => dispatch({ _tag: "Sync", registryId })),
    scheduleEnrichment: (componentIds) =>
      componentIds.length === 0 ? Effect.void : Effect.sync(() => dispatch({ _tag: "Enrich", componentIds })),
  })

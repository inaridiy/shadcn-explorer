import { Effect, Layer } from "effect"
import type { ComponentId, RegistryId } from "@shadcn-explorer/core/domain"
import { JobScheduler, SchedulerError } from "@shadcn-explorer/core/ports"

export interface SyncParams {
  readonly registryId: RegistryId
  /** テーマを判定し直す (registry.json が変わっていなくても) */
  readonly forceTheme?: boolean
}
export interface EnrichParams {
  readonly componentIds: ReadonlyArray<ComponentId>
}
/** エンリッチのキューのメッセージ (1 件 = 1 コンポーネント) */
export interface EnrichMessage {
  readonly componentId: ComponentId
}

const shortId = () => crypto.randomUUID().slice(0, 8)

/** sendBatch は 1 回 100 件まで */
const SEND_BATCH_LIMIT = 100

/**
 * 同期は Cloudflare Workflows、エンリッチは Cloudflare Queues に投入する。
 * エンリッチの同時実行数はキューの消費者の max_concurrency (wrangler.jsonc) で全体に掛かる。
 * 同じコンポーネントを何度投入しても、消費者が計画 (やることが無ければ何もしない) と lease で重複を除く。
 */
export const CloudflareJobScheduler = (env: Env) =>
  Layer.succeed(JobScheduler, {
    scheduleSync: (registryId, options) =>
      Effect.tryPromise({
        try: () =>
          env.SYNC_WORKFLOW.create({
            id: `sync-${registryId}-${shortId()}`.slice(0, 64),
            params: { registryId, ...(options?.forceTheme ? { forceTheme: true } : {}) } satisfies SyncParams,
          }),
        catch: (e) => new SchedulerError({ reason: String(e) }),
      }).pipe(Effect.asVoid),
    scheduleEnrichment: (ids) =>
      Effect.forEach(
        Array.from({ length: Math.ceil(ids.length / SEND_BATCH_LIMIT) }, (_, i) => ids.slice(i * SEND_BATCH_LIMIT, (i + 1) * SEND_BATCH_LIMIT)),
        (part) =>
          Effect.tryPromise({
            try: () => env.ENRICH_QUEUE.sendBatch(part.map((componentId) => ({ body: { componentId } satisfies EnrichMessage }))),
            catch: (e) => new SchedulerError({ reason: String(e) }),
          }),
        { discard: true },
      ),
    // キューの backlog (2026-04 からバインディングで取れる)。取れなければ 0 として扱う (取り込みを止めない)
    pendingEnrichments: () =>
      Effect.tryPromise({
        try: () => env.ENRICH_QUEUE.metrics(),
        catch: (e) => new SchedulerError({ reason: String(e) }),
      }).pipe(Effect.map((m) => m.backlogCount)),
  })

export type InlineJob =
  | { readonly _tag: "Sync"; readonly registryId: RegistryId; readonly forceTheme: boolean }
  | { readonly _tag: "Enrich"; readonly componentIds: ReadonlyArray<ComponentId> }

/** ローカル開発用: waitUntil でリクエスト後にその場で実行する */
export const InlineJobScheduler = (dispatch: (job: InlineJob) => void, pending?: () => number) =>
  Layer.succeed(JobScheduler, {
    scheduleSync: (registryId, options) =>
      Effect.sync(() => dispatch({ _tag: "Sync", registryId, forceTheme: options?.forceTheme === true })),
    scheduleEnrichment: (componentIds) =>
      componentIds.length === 0 ? Effect.void : Effect.sync(() => dispatch({ _tag: "Enrich", componentIds })),
    pendingEnrichments: () => Effect.sync(() => pending?.() ?? 0),
  })

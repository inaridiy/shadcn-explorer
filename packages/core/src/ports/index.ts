/**
 * ポート (ヘキサゴナルアーキテクチャの境界)。
 * アプリケーション層はこれらの Context.Tag にだけ依存し、実装は Layer で差し込む。
 *   - 本番: apps/web/src/infrastructure/* (D1, R2, AI Search, Vectorize, Gemini, Browser Rendering, Agents API)
 *   - テスト/ローカル: @shadcn-explorer/core/testing (インメモリ実装)
 */
import { Context, Data, type Effect, type Option } from "effect"
import type { ComponentKind, ComponentSnapshot } from "../domain/component.js"
import type { Budget, EnrichmentPolicy, MicroUsd, PriceBook, UsageRecord } from "../domain/index.js"
import type { EnrichmentState, UsageDoc } from "../domain/enrichment.js"
import type { ComponentId, RegistryId } from "../domain/ids.js"
import type { Registry } from "../domain/registry.js"

// ---------------------------------------------------------------------------
// Errors (インフラ由来の失敗。ドメインエラーとは分けて扱う)
// ---------------------------------------------------------------------------

export class RegistryFetchError extends Data.TaggedError("RegistryFetchError")<{
  readonly url: string
  readonly reason: string
  readonly status?: number
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly reason: string
  readonly retryable: boolean
}> {}

export class RenderError extends Data.TaggedError("RenderError")<{
  readonly reason: string
}> {}

export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly reason: string
}> {}

export class SearchBackendError extends Data.TaggedError("SearchBackendError")<{
  readonly backend: string
  readonly reason: string
}> {}

export class BlobError extends Data.TaggedError("BlobError")<{
  readonly key: string
  readonly reason: string
}> {}

export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  readonly reason: string
}> {}

// ---------------------------------------------------------------------------
// Registry 取得
// ---------------------------------------------------------------------------

export class RegistryHttp extends Context.Tag("@shadcn-explorer/RegistryHttp")<
  RegistryHttp,
  {
    /** JSON を取得する。サイズ上限・タイムアウトは実装側で担保する */
    readonly getJson: (url: string) => Effect.Effect<unknown, RegistryFetchError>
  }
>() {}

// ---------------------------------------------------------------------------
// 永続化
// ---------------------------------------------------------------------------

export interface RegistryListFilter {
  readonly ownerId?: string
}

export class RegistryRepository extends Context.Tag("@shadcn-explorer/RegistryRepository")<
  RegistryRepository,
  {
    readonly insert: (registry: Registry) => Effect.Effect<void, PersistenceError>
    readonly update: (registry: Registry) => Effect.Effect<void, PersistenceError>
    readonly findById: (id: RegistryId) => Effect.Effect<Option.Option<Registry>, PersistenceError>
    readonly findByIndexUrl: (url: string) => Effect.Effect<Option.Option<Registry>, PersistenceError>
    readonly list: (filter?: RegistryListFilter) => Effect.Effect<ReadonlyArray<Registry>, PersistenceError>
  }
>() {}

/** 読み取りモデル: スナップショット + 生成物 + エンリッチ状態 */
export interface ComponentRecord {
  readonly snapshot: ComponentSnapshot
  readonly doc: Option.Option<UsageDoc>
  readonly enrichment: EnrichmentState
  readonly updatedAt: number
}

export interface ComponentListFilter {
  readonly registryId?: RegistryId
  readonly kinds?: ReadonlyArray<ComponentKind>
  readonly limit: number
  readonly offset: number
}

export class ComponentRepository extends Context.Tag("@shadcn-explorer/ComponentRepository")<
  ComponentRepository,
  {
    /** スナップショットを保存。ハッシュが変わっても生成物・状態は残す (planEnrichment が鮮度を判定する) */
    readonly upsertSnapshots: (snapshots: ReadonlyArray<ComponentSnapshot>) => Effect.Effect<void, PersistenceError>
    readonly remove: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, PersistenceError>
    readonly hashesByRegistry: (
      registryId: RegistryId,
    ) => Effect.Effect<ReadonlyMap<ComponentId, string>, PersistenceError>
    readonly findById: (id: ComponentId) => Effect.Effect<Option.Option<ComponentRecord>, PersistenceError>
    readonly findMany: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<ReadonlyArray<ComponentRecord>, PersistenceError>
    readonly list: (filter: ComponentListFilter) => Effect.Effect<ReadonlyArray<ComponentRecord>, PersistenceError>
    readonly saveDoc: (id: ComponentId, doc: UsageDoc) => Effect.Effect<void, PersistenceError>
    readonly saveEnrichment: (id: ComponentId, state: EnrichmentState) => Effect.Effect<void, PersistenceError>
    readonly countByRegistry: () => Effect.Effect<ReadonlyMap<RegistryId, number>, PersistenceError>
  }
>() {}

export class BlobStore extends Context.Tag("@shadcn-explorer/BlobStore")<
  BlobStore,
  {
    readonly put: (key: string, body: Uint8Array | string, contentType: string) => Effect.Effect<void, BlobError>
    readonly get: (key: string) => Effect.Effect<Option.Option<Uint8Array>, BlobError>
    readonly remove: (keys: ReadonlyArray<string>) => Effect.Effect<void, BlobError>
  }
>() {}

// ---------------------------------------------------------------------------
// AI / レンダリング
// ---------------------------------------------------------------------------

export interface AgentInput {
  readonly snapshot: ComponentSnapshot
  /** registry-item.json そのもの (ファイル内容込み)。Agent がソースを読んで使い方を書く */
  readonly itemJson: unknown
  readonly installCommand: string
}

export interface AgentOutput {
  readonly doc: UsageDoc
  /** 依存を全てバンドル済みの自己完結 HTML。スクショと iframe プレビューに使う */
  readonly previewHtml: Option.Option<string>
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly durationMs: number }
}

/** Coding Agent (CF-Open-Agents-API) による使い方ドキュメント + プレビュー生成 */
export class CodingAgent extends Context.Tag("@shadcn-explorer/CodingAgent")<
  CodingAgent,
  {
    readonly presetName: string
    readonly generate: (input: AgentInput) => Effect.Effect<AgentOutput, AgentError>
  }
>() {}

export type ColorScheme = "light" | "dark"

export class PreviewRenderer extends Context.Tag("@shadcn-explorer/PreviewRenderer")<
  PreviewRenderer,
  {
    /** HTML をヘッドレスブラウザで描画し PNG を返す */
    readonly capture: (
      html: string,
      scheme: ColorScheme,
    ) => Effect.Effect<{ readonly png: Uint8Array; readonly durationMs: number }, RenderError>
  }
>() {}

export type Vector = ReadonlyArray<number>

export class Embedder extends Context.Tag("@shadcn-explorer/Embedder")<
  Embedder,
  {
    readonly model: string
    readonly embedQuery: (text: string) => Effect.Effect<Vector, EmbeddingError>
    readonly embedDocument: (title: string, text: string) => Effect.Effect<Vector, EmbeddingError>
    readonly embedImage: (png: Uint8Array) => Effect.Effect<Vector, EmbeddingError>
  }
>() {}

// ---------------------------------------------------------------------------
// 検索インデックス
// ---------------------------------------------------------------------------

export interface IndexFilters {
  readonly registryIds?: ReadonlyArray<RegistryId>
  readonly kinds?: ReadonlyArray<ComponentKind>
}

export interface TextDocument {
  readonly componentId: ComponentId
  readonly registryId: RegistryId
  readonly kind: ComponentKind
  readonly markdown: string
}

/** テキスト検索 (Cloudflare AI Search: BM25 + ベクトル) */
export class TextSearchIndex extends Context.Tag("@shadcn-explorer/TextSearchIndex")<
  TextSearchIndex,
  {
    readonly upsert: (doc: TextDocument) => Effect.Effect<void, SearchBackendError>
    readonly remove: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, SearchBackendError>
    readonly search: (
      text: string,
      retrieval: "keyword" | "vector",
      filters: IndexFilters,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ComponentId>, SearchBackendError>
  }
>() {}

export type VisualModality = "doc" | "light" | "dark"

export interface VisualVector {
  readonly componentId: ComponentId
  readonly registryId: RegistryId
  readonly kind: ComponentKind
  readonly modality: VisualModality
  readonly values: Vector
}

/** マルチモーダルベクトル検索 (Vectorize + gemini-embedding-2) */
export class VisualIndex extends Context.Tag("@shadcn-explorer/VisualIndex")<
  VisualIndex,
  {
    readonly upsert: (vectors: ReadonlyArray<VisualVector>) => Effect.Effect<void, SearchBackendError>
    readonly remove: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, SearchBackendError>
    readonly query: (
      vector: Vector,
      filters: IndexFilters,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ComponentId>, SearchBackendError>
  }
>() {}

// ---------------------------------------------------------------------------
// ジョブ・コスト・設定
// ---------------------------------------------------------------------------

/** 非同期ジョブの投入口 (本番は Cloudflare Workflows) */
export class JobScheduler extends Context.Tag("@shadcn-explorer/JobScheduler")<
  JobScheduler,
  {
    readonly scheduleSync: (registryId: RegistryId) => Effect.Effect<void, SchedulerError>
    readonly scheduleEnrichment: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, SchedulerError>
  }
>() {}

export class UsageLedger extends Context.Tag("@shadcn-explorer/UsageLedger")<
  UsageLedger,
  {
    readonly record: (record: UsageRecord) => Effect.Effect<void, PersistenceError>
    readonly spentSince: (since: number) => Effect.Effect<MicroUsd, PersistenceError>
  }
>() {}

export class ExplorerConfig extends Context.Tag("@shadcn-explorer/ExplorerConfig")<
  ExplorerConfig,
  {
    readonly prices: PriceBook
    readonly budget: Budget
    readonly enrichment: EnrichmentPolicy
    /** shadcn 公式レジストリディレクトリ (名前空間解決用) */
    readonly directoryUrl: string
    /** Syncing のまま放置されたとみなす時間 */
    readonly syncTimeoutMs: number
  }
>() {}

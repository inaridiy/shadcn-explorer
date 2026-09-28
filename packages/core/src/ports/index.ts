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

export interface DocWriterInput {
  readonly snapshot: ComponentSnapshot
  /** registry-item.json そのもの (ファイル内容込み)。LLM がソースを読んで使い方を書く */
  readonly itemJson: unknown
  readonly installCommand: string
}

export interface LlmUsage {
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly durationMs: number
}

/** 使い方ドキュメントの生成 (LLM 1 回呼び出し。既定 gpt-6-luna) */
export class DocWriter extends Context.Tag("@shadcn-explorer/DocWriter")<
  DocWriter,
  {
    /** 例: "openai:gpt-6-luna" */
    readonly model: string
    readonly write: (input: DocWriterInput) => Effect.Effect<{ readonly doc: UsageDoc; readonly usage: LlmUsage }, AgentError>
  }
>() {}

export interface PreviewBuildInput extends DocWriterInput {
  /** 生成済みのドキュメント (デモ実装のヒント) */
  readonly doc: Option.Option<UsageDoc>
}

/** 実行中のプレビュービルドへのハンドル (Workflow のステップ間で受け渡すのでプレーンな値) */
export interface PreviewJob {
  readonly id: string
  readonly startedAt: number
}

export type PreviewPoll =
  | { readonly _tag: "Running" }
  | {
      readonly _tag: "Done"
      /** None = ビルダーがプレビュー不要と判断した */
      readonly html: Option.Option<string>
      readonly usage: LlmUsage
    }

/**
 * プレビュー HTML のビルド (サンドボックスの Coding Agent。CF-Open-Agents-API)。
 * 数分かかるので start / poll の 2 段階にし、Workflow が step.sleep で耐久的に待てるようにする。
 */
export class PreviewBuilder extends Context.Tag("@shadcn-explorer/PreviewBuilder")<
  PreviewBuilder,
  {
    readonly name: string
    readonly start: (input: PreviewBuildInput) => Effect.Effect<PreviewJob, AgentError>
    readonly poll: (job: PreviewJob) => Effect.Effect<PreviewPoll, AgentError>
    /** 打ち切り時の後始末 (セッション削除など)。失敗しても無視してよい */
    readonly cancel: (job: PreviewJob) => Effect.Effect<void>
  }
>() {}

export type ColorScheme = "light" | "dark"

export class PreviewRenderer extends Context.Tag("@shadcn-explorer/PreviewRenderer")<
  PreviewRenderer,
  {
    /**
     * HTML をヘッドレスブラウザで描画し、配色ごとの PNG を返す。
     * ブラウザ起動が課金・レイテンシの大半を占めるので、1 セッションで全配色を撮る。
     */
    readonly capture: (
      html: string,
      schemes: ReadonlyArray<ColorScheme>,
    ) => Effect.Effect<
      {
        readonly shots: ReadonlyArray<{ readonly scheme: ColorScheme; readonly png: Uint8Array }>
        readonly durationMs: number
      },
      RenderError
    >
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

/** キーワード検索 (BM25)。既定は D1 FTS5、代替に Cloudflare AI Search */
export class TextSearchIndex extends Context.Tag("@shadcn-explorer/TextSearchIndex")<
  TextSearchIndex,
  {
    readonly upsert: (doc: TextDocument) => Effect.Effect<void, SearchBackendError>
    readonly remove: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, SearchBackendError>
    readonly search: (
      text: string,
      filters: IndexFilters,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ComponentId>, SearchBackendError>
  }
>() {}

/** doc = ドキュメントのテキスト、light / dark = スクショ */
export type VectorModality = "doc" | "light" | "dark"

export interface ComponentVector {
  readonly componentId: ComponentId
  readonly registryId: RegistryId
  readonly kind: ComponentKind
  readonly modality: VectorModality
  readonly values: Vector
}

export interface VectorFilters extends IndexFilters {
  /** 検索対象のモダリティ。意味検索は doc、ビジュアル検索は light/dark に絞る (modality gap 対策) */
  readonly modalities: ReadonlyArray<VectorModality>
}

/** マルチモーダルベクトル検索 (Vectorize + gemini-embedding-2)。テキストと画像が同じ空間に入る */
export class VectorIndex extends Context.Tag("@shadcn-explorer/VectorIndex")<
  VectorIndex,
  {
    readonly upsert: (vectors: ReadonlyArray<ComponentVector>) => Effect.Effect<void, SearchBackendError>
    readonly remove: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, SearchBackendError>
    readonly query: (
      vector: Vector,
      filters: VectorFilters,
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
    /** プレビュービルドのポーリング間隔と打ち切り時間 */
    readonly previewBuild: { readonly pollIntervalMs: number; readonly timeoutMs: number }
  }
>() {}

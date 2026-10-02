/**
 * ポート (ヘキサゴナルアーキテクチャの境界)。
 * アプリケーション層はこれらの Context.Tag にだけ依存し、実装は Layer で差し込む。
 *   - 本番: apps/web/src/infrastructure/* (D1, R2, AI Search, Vectorize, Gemini, Browser Rendering, OpenAI, Sandbox)
 *   - テスト/ローカル: @shadcn-explorer/core/testing (インメモリ実装)
 */
import { Context, Data, type Effect, type Option } from "effect"
import type { ComponentKind, ComponentSnapshot } from "../domain/component.js"
import type {
  Budget,
  BuildManifest,
  CostCategory,
  DemoLayout,
  EnrichmentPolicy,
  LlmRouting,
  MicroUsd,
  PreviewDemo,
  PreviewFailureCause,
  PriceBook,
  RegistryPreviewConfig,
  ThemeTokens,
  UsageRecord,
} from "../domain/index.js"
import type { DirectoryEntry, ListingTag } from "../domain/directory.js"
import type { PipelineEvent, StoredPipelineEvent } from "../domain/pipeline.js"
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

export class DocsError extends Data.TaggedError("DocsError")<{
  readonly url: string
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

export interface PipelineLogFilter {
  readonly registryId?: RegistryId
  readonly componentId?: ComponentId
  /** この ID より新しいもの (ポーリングのカーソル) */
  readonly afterId?: number
  /** この時刻以降 */
  readonly since?: number
  readonly limit: number
}

/** 生成過程の公開ログ (pipeline.ts)。追記だけ */
export class PipelineLog extends Context.Tag("@shadcn-explorer/PipelineLog")<
  PipelineLog,
  {
    readonly append: (event: PipelineEvent) => Effect.Effect<void, PersistenceError>
    /** 新しい順ではなく古い順 (ID 昇順) で返す。afterId なしなら最新の limit 件 */
    readonly list: (filter: PipelineLogFilter) => Effect.Effect<ReadonlyArray<StoredPipelineEvent>, PersistenceError>
    /** 古いイベントを消す (保持期間) */
    readonly prune: (before: number) => Effect.Effect<void, PersistenceError>
  }
>() {}

/** 公式ディレクトリの写しと取り込みの状態 (directory.ts) */
export class DirectoryRepository extends Context.Tag("@shadcn-explorer/DirectoryRepository")<
  DirectoryRepository,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<DirectoryEntry>, PersistenceError>
    readonly upsert: (entries: ReadonlyArray<DirectoryEntry>) => Effect.Effect<void, PersistenceError>
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

/**
 * 読み取りモデル: 一覧・検索結果のカード。ComponentRecord の JSON 全体をデコードせずに作れる範囲だけを持つ
 * (D1 では列と json_extract から直接組み立てる)。画像は R2 のキー。
 */
export interface ComponentCard {
  readonly id: ComponentId
  readonly registryId: RegistryId
  readonly name: string
  readonly kind: ComponentKind
  readonly title: string
  readonly description: string
  readonly summary: string | null
  /** レジストリの出自 (バッジ)。掲載が外れた公式レジストリは Community */
  readonly listing: ListingTag
  readonly status: { readonly doc: string; readonly preview: string; readonly index: string }
  /** Captured のときだけ: 静止画 */
  readonly stills: { readonly light: string; readonly dark: string | null } | null
  /** 動き続ける部品だけ: animated WebP */
  readonly motion: { readonly light: string; readonly dark: string | null } | null
}

/** listing はレジストリが持つので、レコード単体からは作れない (呼び出し側が渡す。既定は Community) */
export const toComponentCard = ({ snapshot, doc, enrichment }: ComponentRecord, listing: ListingTag = "Community"): ComponentCard => {
  const preview = enrichment.preview
  const captured = preview._tag === "Captured" ? preview : null
  return {
    id: snapshot.id,
    registryId: snapshot.registryId,
    name: snapshot.name,
    kind: snapshot.kind,
    title: snapshot.title,
    description: snapshot.description,
    summary: doc._tag === "Some" ? doc.value.summary : null,
    listing,
    status: { doc: enrichment.doc._tag, preview: preview._tag, index: enrichment.index._tag },
    stills: captured ? { light: captured.lightKey, dark: captured.darkKey ?? null } : null,
    motion: captured?.motion ? { light: captured.motion.lightKey, dark: captured.motion.darkKey ?? null } : null,
  }
}

/**
 * ギャラリー (プレビューのあるものだけ)。並びは content_hash 順: レジストリをまたいで混ざり、ページをまたいでも安定する。
 * after は前のページの next ("content_hash|id" の keyset ページング。offset と違い深いページでも読む行数が増えない)
 */
export interface GalleryFilter {
  readonly registryIds?: ReadonlyArray<RegistryId>
  readonly kinds?: ReadonlyArray<ComponentKind>
  readonly motionOnly?: boolean
  /** 公式ディレクトリと shadcn/ui のものだけ */
  readonly officialOnly?: boolean
  readonly limit: number
  readonly after?: string
}

export interface GalleryPage {
  readonly cards: ReadonlyArray<ComponentCard>
  readonly next: string | null
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
    /** カードだけ (名前順)。レジストリのページ用 */
    readonly listCards: (filter: ComponentListFilter) => Effect.Effect<ReadonlyArray<ComponentCard>, PersistenceError>
    /** カードだけ。呼び出し側の順序 (検索順位) を保つ */
    readonly findCards: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<ReadonlyArray<ComponentCard>, PersistenceError>
    readonly gallery: (filter: GalleryFilter) => Effect.Effect<GalleryPage, PersistenceError>
    readonly saveDoc: (id: ComponentId, doc: UsageDoc) => Effect.Effect<void, PersistenceError>
    readonly saveEnrichment: (id: ComponentId, state: EnrichmentState) => Effect.Effect<void, PersistenceError>
    readonly countByRegistry: () => Effect.Effect<ReadonlyMap<RegistryId, number>, PersistenceError>
    /** インデックスまで終わっていない数 (取り込みの抑制に使う。無料枠待ちで後回しになっているものも含む) */
    readonly countUnfinished: () => Effect.Effect<number, PersistenceError>
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
  /** 使うモデル (無料枠に応じて呼び出し側が選ぶ)。省略時はアダプタの既定 */
  readonly model?: string
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

export interface DemoWriterInput extends DocWriterInput {
  /** 生成済みのドキュメント (API のヒント) */
  readonly doc: Option.Option<UsageDoc>
  /** ハーネスがデモを置く枠 (kind から決まる。モデルには選ばせない) */
  readonly layout: DemoLayout
}

/**
 * プレビュー用デモ (src/demo.tsx) を書く LLM (1 回呼び出し。既定 gpt-6-luna)。
 * `repair` は同じ入力と前回のコード・問題点 (lint / ビルド / 型エラー) から直したコードを返す。
 */
export class DemoWriter extends Context.Tag("@shadcn-explorer/DemoWriter")<
  DemoWriter,
  {
    readonly model: string
    readonly write: (input: DemoWriterInput) => Effect.Effect<{ readonly code: string; readonly usage: LlmUsage }, AgentError>
    readonly repair: (
      input: DemoWriterInput,
      previous: string,
      problems: ReadonlyArray<string>,
    ) => Effect.Effect<{ readonly code: string; readonly usage: LlmUsage }, AgentError>
  }
>() {}

export interface PreviewCompileInput {
  readonly snapshot: ComponentSnapshot
  /** registry-item.json 原本。ハーネスはこれをローカルファイルとして `shadcn add` する */
  readonly itemJson: unknown
  /** アイテム自身の名前空間 (`@8bitcn`)。宣言漏れの兄弟アイテムはここから探す */
  readonly namespace: string | null
  /** components.json の registries (既知の全名前空間 → アイテム URL テンプレート)。registryDependencies の解決に使う */
  readonly registries: Readonly<Record<string, string>>
  /** レジストリ単位のプレビュー設定 (テーマ CSS・ベースアイテム・依存の固定) */
  readonly registryConfig: RegistryPreviewConfig
  /** フォールバックの Coding Agent が書いたビルド手順。null = 決まった手順だけ */
  readonly manifest: BuildManifest | null
  readonly demo: PreviewDemo
}

/**
 * - Compiled: 単一の自己完結 HTML ができた。`diagnostics` は demo.tsx の型エラー (描画はできるが直す価値がある)
 * - Rejected: install (アイテム自体が入らない) か build で失敗。`cause` は誰の問題か (registry / demo / harness)
 * `workarounds` は素の `shadcn add` からの逸脱 (UI に出し、効果を測る)
 */
export type PreviewCompileResult =
  | {
      readonly _tag: "Compiled"
      readonly html: string
      readonly diagnostics: ReadonlyArray<string>
      readonly workarounds: ReadonlyArray<string>
      readonly durationMs: number
    }
  | {
      readonly _tag: "Rejected"
      readonly stage: "install" | "build"
      readonly cause: Exclude<PreviewFailureCause, "infra">
      readonly errors: ReadonlyArray<string>
      readonly workarounds: ReadonlyArray<string>
      readonly durationMs: number
    }

/**
 * デモを決定的にビルドする (コンテナ内のハーネス: shadcn add → vite build → 単一 HTML)。
 * LLM は使わない。インフラ障害は AgentError、アイテム・デモ起因の失敗は Rejected で返す。
 */
export class PreviewCompiler extends Context.Tag("@shadcn-explorer/PreviewCompiler")<
  PreviewCompiler,
  {
    readonly name: string
    readonly compile: (input: PreviewCompileInput) => Effect.Effect<PreviewCompileResult, AgentError>
  }
>() {}

// ---------------------------------------------------------------------------
// フォールバックの Coding Agent (CF-Open-Agents-API)
// ---------------------------------------------------------------------------

export interface PreviewAgentInput {
  readonly snapshot: ComponentSnapshot
  readonly itemJson: unknown
  readonly namespace: string | null
  readonly registries: Readonly<Record<string, string>>
  readonly registryConfig: RegistryPreviewConfig
  readonly layout: DemoLayout
  /** 決まった手順で最後に試したデモと、その失敗 */
  readonly lastDemo: string
  readonly errors: ReadonlyArray<string>
  readonly cause: PreviewFailureCause
}

/** 実行中のエージェントへのハンドル (Workflow のステップ間で受け渡すのでプレーンな値) */
export interface PreviewAgentJob {
  readonly id: string
  readonly startedAt: number
}

export type PreviewAgentPoll =
  | { readonly _tag: "Running" }
  | {
      readonly _tag: "Done"
      /** Recipe = ビルド手順 (未検証の JSON)。GaveUp = エージェントが直せないと判断した (理由付き) */
      readonly result:
        | { readonly _tag: "Recipe"; readonly demo: string; readonly manifest: unknown }
        | { readonly _tag: "GaveUp"; readonly reason: string }
      readonly usage: LlmUsage
    }

/**
 * 決まった手順で直せなかったアイテムを、サンドボックスの Coding Agent に試させる。
 * 成果物は HTML ではなくビルド手順 (demo.tsx + manifest)。こちらのコンテナで決定的に再実行し、回避策として表示する。
 */
export class PreviewAgent extends Context.Tag("@shadcn-explorer/PreviewAgent")<
  PreviewAgent,
  {
    readonly name: string
    readonly start: (input: PreviewAgentInput) => Effect.Effect<PreviewAgentJob, AgentError>
    readonly poll: (job: PreviewAgentJob) => Effect.Effect<PreviewAgentPoll, AgentError>
    /** 打ち切り時の後始末。失敗しても無視してよい */
    readonly cancel: (job: PreviewAgentJob) => Effect.Effect<void>
  }
>() {}

// ---------------------------------------------------------------------------
// テーマ: インストール手順を読む Coding Agent と、ドキュメントの読み取り
// ---------------------------------------------------------------------------

export interface ThemeAgentInput {
  readonly registry: Registry
  /** registry.json のアイテム一覧 (名前・種別・説明。内容は含めない) */
  readonly items: ReadonlyArray<{ readonly name: string; readonly type: string; readonly description: string }>
  /** 候補のテーマで試しにビルドする代表アイテム (registry-item.json 原本と、あれば既存のデモ) */
  readonly samples: ReadonlyArray<{ readonly name: string; readonly itemJson: unknown; readonly demo: string | null; readonly layout: DemoLayout }>
  readonly registries: Readonly<Record<string, string>>
  /** こちらで先に読んだドキュメント (インストール手順・テーマの候補ページ) */
  readonly docs: ReadonlyArray<{ readonly url: string; readonly markdown: string }>
  /** baseItems とドキュメントの閲覧を許すホスト (レジストリ自身のサイト) */
  readonly allowedHosts: ReadonlyArray<string>
}

export type ThemeAgentPoll =
  | { readonly _tag: "Running" }
  | {
      readonly _tag: "Done"
      /** Proposal = theme.json (未検証の JSON)。GaveUp = 手順が見つからない・テーマが無いと判断した (理由付き) */
      readonly result: { readonly _tag: "Proposal"; readonly raw: unknown } | { readonly _tag: "GaveUp"; readonly reason: string }
      readonly usage: LlmUsage
    }

/**
 * registry.json で決まらないレジストリのテーマを、インストール手順を読んで提案させる (CF-Open-Agents-API)。
 * サンドボックスには同じハーネスがあり、候補を実際に `shadcn add` してビルド・撮影して確かめられる。
 * 成果物は設定 (データ) と根拠。こちらで検証し、運営者が承認してから適用する。
 */
export class ThemeAgent extends Context.Tag("@shadcn-explorer/ThemeAgent")<
  ThemeAgent,
  {
    readonly name: string
    readonly start: (input: ThemeAgentInput) => Effect.Effect<PreviewAgentJob, AgentError>
    readonly poll: (job: PreviewAgentJob) => Effect.Effect<ThemeAgentPoll, AgentError>
    readonly cancel: (job: PreviewAgentJob) => Effect.Effect<void>
  }
>() {}

/** Web ページを LLM 向けの Markdown にする (webforai platform) */
export class DocsReader extends Context.Tag("@shadcn-explorer/DocsReader")<
  DocsReader,
  {
    readonly name: string
    /** ページ内のリンク (絶対 URL) */
    readonly links: (url: string) => Effect.Effect<ReadonlyArray<string>, DocsError>
    readonly read: (url: string) => Effect.Effect<{ readonly url: string; readonly markdown: string }, DocsError>
  }
>() {}

export type AgentRunOutcome = "succeeded" | "failed" | "rejected" | "gave_up" | "timed_out"

export interface AgentRun {
  readonly componentId: ComponentId
  readonly registryId: RegistryId
  readonly buildVersion: string
  readonly outcome: AgentRunOutcome
  readonly workarounds: ReadonlyArray<string>
  readonly detail: string
  readonly at: number
}

/**
 * エージェント実行の記録。上限 (レジストリ単位) と遮断機 (成功率) の判断、
 * 「どの回避策が繰り返し使われているか」(固定ルールやレジストリのデータへの格上げの判断材料) に使う。
 */
export class AgentRunLedger extends Context.Tag("@shadcn-explorer/AgentRunLedger")<
  AgentRunLedger,
  {
    readonly record: (run: AgentRun) => Effect.Effect<void, PersistenceError>
    readonly stats: (
      registryId: RegistryId,
      buildVersion: string,
    ) => Effect.Effect<{ readonly runs: number; readonly succeeded: number }, PersistenceError>
  }
>() {}

export type ColorScheme = "light" | "dark"

export class PreviewRenderer extends Context.Tag("@shadcn-explorer/PreviewRenderer")<
  PreviewRenderer,
  {
    /**
     * HTML をヘッドレスブラウザで描画し、配色ごとの静止画を返す。
     * 表示用の WebP と、画像埋め込み用の JPEG (Gemini Embedding 2 は PNG / JPEG しか受け付けない) の組。
     * ブラウザ起動が課金・レイテンシの大半を占めるので、1 セッションで全配色を撮る。
     */
    readonly capture: (
      html: string,
      schemes: ReadonlyArray<ColorScheme>,
      layout: DemoLayout,
      /** レジストリの既定のトークン。ビルド済み HTML に注入してから撮る (トークンだけの変更でビルドし直さない) */
      options?: { readonly tokens?: ThemeTokens },
    ) => Effect.Effect<
      {
        readonly shots: ReadonlyArray<{ readonly scheme: ColorScheme; readonly webp: Uint8Array; readonly jpeg: Uint8Array }>
        readonly durationMs: number
        /** 描画時の例外 (ハーネスのエラーバウンダリ・pageerror)。あればデモが壊れている */
        readonly runtimeErrors: ReadonlyArray<string>
        /**
         * 動き続ける部品だけ、配色ごとの animated WebP (実時間で再生される)。ピクセルの差分で判定する
         * (登場アニメーションだけで止まるもの・ホバーでだけ動くものは静止扱い)
         */
        readonly motion: ReadonlyArray<{ readonly scheme: ColorScheme; readonly webp: Uint8Array; readonly durationMs: number }> | null
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
    readonly embedImage: (image: Uint8Array) => Effect.Effect<Vector, EmbeddingError>
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
  /** 除外するレジストリ (「よそで似ているもの」で自分のレジストリを外す) */
  readonly excludeRegistryIds?: ReadonlyArray<RegistryId>
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
    /** 保存済みのベクトルを引く (似たものを探す起点)。無いモダリティは返さない */
    readonly vectorsOf: (
      componentId: ComponentId,
      modalities: ReadonlyArray<VectorModality>,
    ) => Effect.Effect<ReadonlyArray<ComponentVector>, SearchBackendError>
  }
>() {}

// ---------------------------------------------------------------------------
// ジョブ・コスト・設定
// ---------------------------------------------------------------------------

/** 非同期ジョブの投入口 (本番は Cloudflare Workflows) */
export class JobScheduler extends Context.Tag("@shadcn-explorer/JobScheduler")<
  JobScheduler,
  {
    /** forceTheme: テーマを判定し直す (registry.json が変わっていなくても。必要ならエージェントも回す) */
    readonly scheduleSync: (registryId: RegistryId, options?: { readonly forceTheme?: boolean }) => Effect.Effect<void, SchedulerError>
    readonly scheduleEnrichment: (ids: ReadonlyArray<ComponentId>) => Effect.Effect<void, SchedulerError>
    /** まだ処理されていないエンリッチの数 (キューの backlog)。公式ディレクトリの取り込みを、詰まっている間は止めるのに使う */
    readonly pendingEnrichments: () => Effect.Effect<number, SchedulerError>
  }
>() {}

export class UsageLedger extends Context.Tag("@shadcn-explorer/UsageLedger")<
  UsageLedger,
  {
    readonly record: (record: UsageRecord) => Effect.Effect<void, PersistenceError>
    /** category を渡すとそのカテゴリだけ (エージェントの月次上限など) */
    readonly spentSince: (since: number, category?: CostCategory) => Effect.Effect<MicroUsd, PersistenceError>
    /** モデル別のトークン数 (input + output) の合計。OpenAI の無料枠の日次集計に使う */
    readonly tokensByModelSince: (since: number) => Effect.Effect<ReadonlyMap<string, number>, PersistenceError>
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
    /** ステップごとのモデルと OpenAI の無料枠 (v0.7) */
    readonly llm: LlmRouting
    /** 取り込みと再同期のライフサイクル (v0.7) */
    readonly lifecycle: {
      /** 各レジストリを再同期する間隔 (7 日) */
      readonly resyncIntervalMs: number
      /** 1 回の cron で再同期を投入する上限 (夜ごとに分散させる) */
      readonly resyncPerRun: number
      /** 公式ディレクトリを自動で取り込むか */
      readonly directoryIntake: boolean
      /** 1 回の cron で新しく取り込む公式レジストリの数 */
      readonly intakePerRun: number
      /** エンリッチの backlog がこれを超えている間は取り込まない */
      readonly maxBacklog: number
    }
    /** registry.json でテーマが決まらないレジストリを、エージェントにインストール手順を読ませて調べるか */
    readonly themeAgent: boolean
    readonly previewBuild: {
      /** デモのビルドエラーを LLM に直させる最大回数 */
      readonly maxRepairs: number
      /** フォールバックの Coding Agent。null = 無効 */
      readonly agent: {
        /** レジストリ単位・BUILD_VERSION 単位の上限: min(maxPerRegistry, アイテム数 × maxRatio) */
        readonly maxPerRegistry: number
        readonly maxRatio: number
        /** エージェントの月次予算 (全体予算とは別枠) */
        readonly monthlyBudget: MicroUsd
        /** 遮断機: minRuns 回以上試して成功率が minSuccessRate 未満のレジストリには委譲しない */
        readonly breakerMinRuns: number
        readonly breakerMinSuccessRate: number
        readonly pollIntervalMs: number
        readonly timeoutMs: number
      } | null
    }
  }
>() {}

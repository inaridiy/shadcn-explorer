import { Effect, Layer } from "effect"
import { FakeDocWriter, FakeEmbedder, FakePreviewBuilder, FakePreviewRenderer } from "@shadcn-explorer/core/testing"
import {
  AgentError,
  DocWriter,
  Embedder,
  EmbeddingError,
  PreviewBuilder,
  PreviewRenderer,
  RenderError,
} from "@shadcn-explorer/core/ports"
import { AgentsPreviewBuilder, makeAgentsTransport } from "./agents-preview-builder"
import { AiSearchTextIndex } from "./ai-search-text-index"
import { BrowserPreviewRenderer } from "./browser-preview-renderer"
import { makeExplorerConfig } from "./config"
import { D1ComponentRepository, D1RegistryRepository, D1UsageLedger } from "./d1-repositories"
import { D1FtsTextIndex, D1LocalVectorIndex } from "./d1-search-indexes"
import { GeminiEmbedder } from "./gemini-embedder"
import { type InlineJob, InlineJobScheduler, WorkflowJobScheduler } from "./job-scheduler"
import { OpenAIDocWriter } from "./openai-doc-writer"
import { R2BlobStore } from "./r2-blob-store"
import { FetchRegistryHttp } from "./registry-http"
import { VectorizeVectorIndex } from "./vectorize-vector-index"

export type ExplorerMode = "cloudflare" | "local"

export const modeOf = (env: Env): ExplorerMode => (env.EXPLORER_MODE === "local" ? "local" : "cloudflare")

/** 設定が無いときは「未設定」で失敗する実装を入れる (本番でフェイクが紛れ込まないように) */
const unconfiguredDocWriter = Layer.succeed(DocWriter, {
  model: "unconfigured",
  write: () => Effect.fail(new AgentError({ reason: "OPENAI_API_KEY が設定されていません", retryable: false })),
})
const unconfiguredPreviewBuilder = Layer.succeed(PreviewBuilder, {
  name: "unconfigured",
  start: () => Effect.fail(new AgentError({ reason: "Agents API が設定されていません", retryable: false })),
  poll: () => Effect.fail(new AgentError({ reason: "Agents API が設定されていません", retryable: false })),
  cancel: () => Effect.void,
})
const unconfiguredEmbedder = Layer.succeed(Embedder, {
  model: "unconfigured",
  embedQuery: () => Effect.fail(new EmbeddingError({ reason: "GEMINI_API_KEY が設定されていません" })),
  embedDocument: () => Effect.fail(new EmbeddingError({ reason: "GEMINI_API_KEY が設定されていません" })),
  embedImage: () => Effect.fail(new EmbeddingError({ reason: "GEMINI_API_KEY が設定されていません" })),
})
const unconfiguredRenderer = Layer.succeed(PreviewRenderer, {
  capture: () => Effect.fail(new RenderError({ reason: "BROWSER binding がありません" })),
})

/** ドキュメント: OpenAI Responses API (gpt-6-luna) → (local のみ) フェイク */
const docWriterLayer = (env: Env, mode: ExplorerMode) => {
  if (env.OPENAI_API_KEY) {
    return OpenAIDocWriter({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-6-luna",
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
    })
  }
  return mode === "local" ? FakeDocWriter() : unconfiguredDocWriter
}

/**
 * プレビュー: サンドボックス Agent (CF-Open-Agents-API) → (local のみ) フェイク。
 * どちらも無い本番環境ではプレビュー自体を無効化する (enabled=false → planEnrichment が計画しない)。
 */
const previewBuilderLayer = (env: Env, mode: ExplorerMode) => {
  const transport = makeAgentsTransport(env, mode === "cloudflare")
  if (transport) return { layer: AgentsPreviewBuilder({ transport, preset: env.AGENT_PRESET }), enabled: true }
  if (mode === "local") return { layer: FakePreviewBuilder(), enabled: true }
  return { layer: unconfiguredPreviewBuilder, enabled: false }
}

const embedderLayer = (env: Env, mode: ExplorerMode) => {
  if (env.GEMINI_API_KEY) {
    return GeminiEmbedder({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_EMBEDDING_MODEL,
      dimensions: Number(env.GEMINI_EMBEDDING_DIMENSIONS) || 1536,
      ...(env.AI_GATEWAY_BASE_URL ? { gatewayBaseUrl: env.AI_GATEWAY_BASE_URL } : {}),
      ...(env.AI_GATEWAY_TOKEN ? { gatewayToken: env.AI_GATEWAY_TOKEN } : {}),
    })
  }
  return mode === "local" ? FakeEmbedder : unconfiguredEmbedder
}

const rendererLayer = (env: Env, mode: ExplorerMode) => {
  if (mode === "local") return FakePreviewRenderer
  return env.BROWSER ? BrowserPreviewRenderer(env.BROWSER) : unconfiguredRenderer
}

/**
 * env から全ポートの実装を組み立てる (Composition Root)。
 * - cloudflare: D1 / R2 / D1 FTS5 (or AI Search) / Vectorize / Browser Rendering / OpenAI / Agents API / Workflows
 * - local:      D1 / R2 (miniflare) + D1 FTS5 + D1 ベクトル + フェイク AI (OPENAI_API_KEY があれば実 LLM)
 */
export const makeAppLayer = (env: Env, dispatch: (job: InlineJob) => void) => {
  const mode = modeOf(env)
  const textIndex = env.TEXT_SEARCH_BACKEND === "ai-search" && mode === "cloudflare"
    ? AiSearchTextIndex(env.COMPONENT_SEARCH)
    : D1FtsTextIndex(env.DB)
  const vectorIndex = mode === "local" ? D1LocalVectorIndex(env.DB) : VectorizeVectorIndex(env.VISUAL_INDEX)
  const scheduler = mode === "local" ? InlineJobScheduler(dispatch) : WorkflowJobScheduler(env)
  const preview = previewBuilderLayer(env, mode)

  return Layer.mergeAll(
    FetchRegistryHttp,
    D1RegistryRepository(env.DB),
    D1ComponentRepository(env.DB),
    D1UsageLedger(env.DB),
    R2BlobStore(env.MEDIA),
    docWriterLayer(env, mode),
    preview.layer,
    rendererLayer(env, mode),
    embedderLayer(env, mode),
    textIndex,
    vectorIndex,
    scheduler,
    makeExplorerConfig(env, { previewsEnabled: preview.enabled }),
  )
}

export type AppServices = Layer.Layer.Success<ReturnType<typeof makeAppLayer>>

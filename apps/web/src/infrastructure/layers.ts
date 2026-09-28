import { Effect, Layer } from "effect"
import { FakeCodingAgent, FakeEmbedder, FakePreviewRenderer } from "@shadcn-explorer/core/testing"
import {
  AgentError,
  CodingAgent,
  Embedder,
  EmbeddingError,
  PreviewRenderer,
  RenderError,
} from "@shadcn-explorer/core/ports"
import { AgentsCodingAgent, makeAgentsTransport } from "./agents-coding-agent"
import { AiSearchTextIndex } from "./ai-search-text-index"
import { BrowserPreviewRenderer } from "./browser-preview-renderer"
import { makeExplorerConfig } from "./config"
import { D1ComponentRepository, D1RegistryRepository, D1UsageLedger } from "./d1-repositories"
import { D1FtsTextIndex, D1LocalVisualIndex } from "./d1-search-indexes"
import { GeminiEmbedder } from "./gemini-embedder"
import { type InlineJob, InlineJobScheduler, WorkflowJobScheduler } from "./job-scheduler"
import { R2BlobStore } from "./r2-blob-store"
import { FetchRegistryHttp } from "./registry-http"
import { VectorizeVisualIndex } from "./vectorize-visual-index"

export type ExplorerMode = "cloudflare" | "local"

export const modeOf = (env: Env): ExplorerMode => (env.EXPLORER_MODE === "local" ? "local" : "cloudflare")

/** 設定が無いときは「未設定」で失敗する実装を入れる (本番でフェイクが紛れ込まないように) */
const unconfiguredAgent = Layer.succeed(CodingAgent, {
  presetName: "unconfigured",
  generate: () => Effect.fail(new AgentError({ reason: "Agents API が設定されていません", retryable: false })),
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

const agentLayer = (env: Env, mode: ExplorerMode) => {
  const transport = makeAgentsTransport(env)
  if (transport) return AgentsCodingAgent({ transport, preset: env.AGENT_PRESET })
  return mode === "local" ? FakeCodingAgent() : unconfiguredAgent
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
 * - cloudflare: D1 / R2 / AI Search / Vectorize / Browser Rendering / Agents API / Workflows
 * - local:      D1 / R2 (miniflare) + D1 FTS5 + フェイク AI。API キー無しで一通り動く
 */
export const makeAppLayer = (env: Env, dispatch: (job: InlineJob) => void) => {
  const mode = modeOf(env)
  const textIndex =
    mode === "local" || env.TEXT_SEARCH_BACKEND === "d1" ? D1FtsTextIndex(env.DB) : AiSearchTextIndex(env.COMPONENT_SEARCH)
  const visualIndex = mode === "local" ? D1LocalVisualIndex(env.DB) : VectorizeVisualIndex(env.VISUAL_INDEX)
  const scheduler = mode === "local" ? InlineJobScheduler(dispatch) : WorkflowJobScheduler(env)

  return Layer.mergeAll(
    FetchRegistryHttp,
    D1RegistryRepository(env.DB),
    D1ComponentRepository(env.DB),
    D1UsageLedger(env.DB),
    R2BlobStore(env.MEDIA),
    agentLayer(env, mode),
    rendererLayer(env, mode),
    embedderLayer(env, mode),
    textIndex,
    visualIndex,
    scheduler,
    makeExplorerConfig(env),
  )
}

export type AppServices = Layer.Layer.Success<ReturnType<typeof makeAppLayer>>

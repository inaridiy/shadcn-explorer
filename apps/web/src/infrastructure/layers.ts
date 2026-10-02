import { Effect, Layer } from "effect"
import {
  FakeDemoWriter,
  FakeDocWriter,
  FakeEmbedder,
  FakePreviewAgent,
  FakePreviewCompiler,
  FakePreviewRenderer,
  FakeThemeAgent,
} from "@shadcn-explorer/core/testing"
import {
  AgentError,
  DemoWriter,
  DocWriter,
  Embedder,
  EmbeddingError,
  PreviewAgent,
  PreviewCompiler,
  PreviewRenderer,
  RenderError,
  ThemeAgent,
} from "@shadcn-explorer/core/ports"
import { AgentsPreviewAgent, makeAgentsTransport } from "./agents-preview-agent"
import { AgentsThemeAgent } from "./agents-theme-agent"
import { AiSearchTextIndex } from "./ai-search-text-index"
import { makeExplorerConfig } from "./config"
import type { D1Client } from "./d1"
import {
  D1AgentRunLedger,
  D1ComponentRepository,
  D1DirectoryRepository,
  D1PipelineLog,
  D1RegistryRepository,
  D1UsageLedger,
} from "./d1-repositories"
import { D1FtsTextIndex, D1LocalVectorIndex } from "./d1-search-indexes"
import { GeminiEmbedder } from "./gemini-embedder"
import { CloudflareJobScheduler, type InlineJob, InlineJobScheduler } from "./job-scheduler"
import { OpenAIDemoWriter } from "./openai-demo-writer"
import { OpenAIDocWriter } from "./openai-doc-writer"
import { R2BlobStore } from "./r2-blob-store"
import { SandboxPreviewCompiler, SandboxPreviewRenderer } from "./sandbox-preview-compiler"
import { FetchRegistryHttp } from "./registry-http"
import { VectorizeVectorIndex } from "./vectorize-vector-index"
import { NoDocsReader, type PlatformRpc, WebforaiDocsReader } from "./webforai-docs-reader"

export type ExplorerMode = "cloudflare" | "local"

export const modeOf = (env: Env): ExplorerMode => (env.EXPLORER_MODE === "local" ? "local" : "cloudflare")

/** 設定が無いときは「未設定」で失敗する実装を入れる (本番でフェイクが紛れ込まないように) */
const unconfiguredDocWriter = Layer.succeed(DocWriter, {
  model: "unconfigured",
  write: () => Effect.fail(new AgentError({ reason: "OPENAI_API_KEY が設定されていません", retryable: false })),
})
const unconfiguredDemoWriter = Layer.succeed(DemoWriter, {
  model: "unconfigured",
  write: () => Effect.fail(new AgentError({ reason: "OPENAI_API_KEY が設定されていません", retryable: false })),
  repair: () => Effect.fail(new AgentError({ reason: "OPENAI_API_KEY が設定されていません", retryable: false })),
})
const unconfiguredCompiler = Layer.succeed(PreviewCompiler, {
  name: "unconfigured",
  compile: () => Effect.fail(new AgentError({ reason: "SANDBOX binding がありません", retryable: false })),
})
const unconfiguredAgent = Layer.succeed(PreviewAgent, {
  name: "unconfigured",
  start: () => Effect.fail(new AgentError({ reason: "Agents API が設定されていません", retryable: false })),
  poll: () => Effect.fail(new AgentError({ reason: "Agents API が設定されていません", retryable: false })),
  cancel: () => Effect.void,
})
const unconfiguredThemeAgent = Layer.succeed(ThemeAgent, {
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
  capture: () => Effect.fail(new RenderError({ reason: "SANDBOX binding がありません" })),
})

/** ドキュメント: OpenAI Responses API (gpt-6-luna) → (local のみ) フェイク */
const docWriterLayer = (env: Env, mode: ExplorerMode) => {
  if (env.OPENAI_API_KEY) {
    return OpenAIDocWriter({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-6-luna",
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
      ...(env.AI_GATEWAY_TOKEN ? { gatewayToken: env.AI_GATEWAY_TOKEN } : {}),
    })
  }
  return mode === "local" ? FakeDocWriter() : unconfiguredDocWriter
}

/**
 * プレビュー: デモを書く LLM (OpenAI) + ビルド・撮影用コンテナ (Cloudflare Sandbox) + フォールバックの Coding Agent。
 * - local: フェイク (Docker もキーも不要)
 * - cloudflare: LLM とコンテナが揃っていなければプレビュー自体を無効化する (enabled=false → planEnrichment が計画しない)。
 *   エージェント (AGENTS binding) は任意。無ければ決まった手順だけで、直せないものは失敗として表示する
 */
const previewLayers = (env: Env, mode: ExplorerMode) => {
  if (mode === "local") {
    return {
      // テーマのエージェントはフェイク (手順が見つからないと答える)。ローカルでは既定で回さない (themeAgent: false)
      layer: Layer.mergeAll(FakeDemoWriter(), FakePreviewCompiler(), FakePreviewRenderer, FakePreviewAgent(), FakeThemeAgent(), NoDocsReader),
      enabled: true,
      fake: true,
      agent: true,
      themeAgent: false,
    }
  }
  if (env.OPENAI_API_KEY && env.SANDBOX) {
    const writer = OpenAIDemoWriter({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL || "gpt-6-luna",
      ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
      ...(env.AI_GATEWAY_TOKEN ? { gatewayToken: env.AI_GATEWAY_TOKEN } : {}),
    })
    const transport = makeAgentsTransport(env, true)
    const agent = transport ? AgentsPreviewAgent({ transport, preset: env.AGENT_PRESET || "shadcn-explorer" }) : unconfiguredAgent
    const themeAgent = transport ? AgentsThemeAgent({ transport, preset: env.AGENT_PRESET || "shadcn-explorer" }) : unconfiguredThemeAgent
    return {
      layer: Layer.mergeAll(
        writer,
        SandboxPreviewCompiler(env.SANDBOX),
        SandboxPreviewRenderer(env.SANDBOX),
        agent,
        themeAgent,
        WebforaiDocsReader(env.WEBFORAI as unknown as PlatformRpc),
      ),
      enabled: true,
      fake: false,
      agent: transport !== null,
      themeAgent: transport !== null,
    }
  }
  return {
    layer: Layer.mergeAll(
      unconfiguredDemoWriter,
      unconfiguredCompiler,
      unconfiguredRenderer,
      unconfiguredAgent,
      unconfiguredThemeAgent,
      NoDocsReader,
    ),
    enabled: false,
    fake: false,
    agent: false,
    themeAgent: false,
  }
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

/**
 * env から全ポートの実装を組み立てる (Composition Root)。
 * - cloudflare: D1 / R2 / D1 FTS5 (or AI Search) / Vectorize / OpenAI / Sandbox (ビルド + Playwright) / Agents API / Workflows
 * - local:      D1 / R2 (miniflare) + D1 FTS5 + D1 ベクトル + フェイク AI (OPENAI_API_KEY があれば実 LLM)
 */
export const makeAppLayer = (env: Env, dispatch: (job: InlineJob) => void, options: { readonly db?: D1Client } = {}) => {
  const mode = modeOf(env)
  const db = options.db ?? env.DB
  const textIndex = env.TEXT_SEARCH_BACKEND === "ai-search" && mode === "cloudflare"
    ? AiSearchTextIndex(env.COMPONENT_SEARCH)
    : D1FtsTextIndex(db)
  const vectorIndex = mode === "local" ? D1LocalVectorIndex(db) : VectorizeVectorIndex(env.VISUAL_INDEX)
  // JOB_RUNNER=inline: キュー・Workflow を使わず、その場で回す
  const scheduler = mode === "local" || env.JOB_RUNNER === "inline" ? InlineJobScheduler(dispatch) : CloudflareJobScheduler(env)
  const preview = previewLayers(env, mode)

  return Layer.mergeAll(
    FetchRegistryHttp,
    D1RegistryRepository(db),
    D1ComponentRepository(db),
    D1DirectoryRepository(db),
    D1PipelineLog(db),
    D1UsageLedger(db),
    D1AgentRunLedger(db),
    R2BlobStore(env.MEDIA),
    docWriterLayer(env, mode),
    preview.layer,
    embedderLayer(env, mode),
    textIndex,
    vectorIndex,
    scheduler,
    makeExplorerConfig(env, {
      previewsEnabled: preview.enabled,
      fakePreviewBuilder: preview.fake,
      agentEnabled: preview.agent,
      themeAgentEnabled: preview.themeAgent,
    }),
  )
}

export type AppServices = Layer.Layer.Success<ReturnType<typeof makeAppLayer>>

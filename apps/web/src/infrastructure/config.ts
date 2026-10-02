import { Layer } from "effect"
import { BUILD_VERSION, CAPTURE_VERSION, type TokenRates, usd } from "@shadcn-explorer/core/domain"
import { ExplorerConfig } from "@shadcn-explorer/core/ports"

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && value !== undefined && value !== "" ? n : fallback
}

/**
 * gpt-6-luna の単価 (USD / 1M tokens)。2026-09 時点の公式価格
 * https://developers.openai.com/api/docs/pricing
 */
export const GPT_6_LUNA: TokenRates = { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5 }

/**
 * gpt-5.6-luna の単価 (USD / 1M tokens)。gpt-6-luna の 2 倍なので、無料枠を使い切った後の有料は gpt-6-luna に回す。
 * キャッシュ入力の単価は未確認 (入力の 1/10 と仮定)。LLM_RATES で上書きできる
 */
export const GPT_5_6_LUNA: TokenRates = { inputPerMTok: 0.2, cachedInputPerMTok: 0.02, outputPerMTok: 1.2 }

const list = (value: string | undefined, fallback: ReadonlyArray<string>) => {
  const items = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  return items.length > 0 ? items : fallback
}

/**
 * OpenAI の無料枠 (Complimentary daily tokens。組織でデータ共有を有効にしている場合)。
 * 群の中で合算し、00:00 UTC にリセットされる。群の上限は FREE_QUOTA_1M / FREE_QUOTA_10M で上書きできる
 * (Tier 1-2 は 250k / 2.5M)。FREE_QUOTA=off で無料枠を使わない (従来どおり有料)
 */
const quotaGroups = (env: Env) =>
  env.FREE_QUOTA === "off"
    ? []
    : [
        {
          name: "1m",
          models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"],
          dailyTokens: num(env.FREE_QUOTA_1M, 1_000_000),
        },
        {
          name: "10m",
          models: ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.4-nano"],
          dailyTokens: num(env.FREE_QUOTA_10M, 10_000_000),
        },
      ]

const rates = (env: Env, prefix: "DOC" | "PREVIEW", fallback: TokenRates): TokenRates => ({
  inputPerMTok: num(env[`${prefix}_MODEL_INPUT_USD_PER_MTOK`], fallback.inputPerMTok),
  cachedInputPerMTok: num(env[`${prefix}_MODEL_CACHED_INPUT_USD_PER_MTOK`], fallback.cachedInputPerMTok),
  outputPerMTok: num(env[`${prefix}_MODEL_OUTPUT_USD_PER_MTOK`], fallback.outputPerMTok),
})

/**
 * 単価表と予算。docs/DESIGN.md「コスト設計」と対応する。
 * - 実コストは実トークン数 × rates で台帳に積む。…Estimate は予算判断と登録時の見積もりにだけ使う
 * - docTokensEstimate: 実測 (docs/DESIGN.md 9.2) に基づく
 * - previewTokensEstimate: デモ生成 1 回 + 修正の期待値 (約 0.5 回)。入力はアイテムのソース込み
 * - sandbox: Containers standard-3 (2 vCPU・8 GiB) ≈ $0.00006 / 秒。ビルド 1 件約 15 秒 (描画確認込み)、撮影 4〜12 秒
 * - Browser Rendering $0.09 / browser-hour、gemini-embedding-2 $0.20 / 1M text tokens・約 $0.00012 / image
 */
export const makeExplorerConfig = (
  env: Env,
  options: {
    readonly previewsEnabled: boolean
    readonly fakePreviewBuilder?: boolean
    readonly agentEnabled: boolean
    readonly themeAgentEnabled: boolean
  },
) =>
  Layer.succeed(ExplorerConfig, {
    prices: {
      docModel: rates(env, "DOC", GPT_6_LUNA),
      docTokensEstimate: { inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 3_000 },
      previewModel: rates(env, "PREVIEW", GPT_6_LUNA),
      previewTokensEstimate: { inputTokens: 20_000, cachedInputTokens: 8_000, outputTokens: 4_000 },
      // フェイクのビルダー (local) ではコンテナ費用は発生しない
      // standard-3 (2 vCPU・8 GiB): vCPU $0.00002/s × 2 + メモリ $0.0000025/GiB-s × 8 ≈ $0.00006/s
      sandboxPerSecond: options.fakePreviewBuilder ? usd(0) : usd(0.00006),
      sandboxSecondsPerPreview: 30,
      // 撮影もコンテナ内の Playwright (v0.5)。見積もりはコンテナの単価 × 撮影の秒数 (動く部品は録画込みで長め)
      browserPerSecond: options.fakePreviewBuilder ? usd(0) : usd(0.00006),
      browserSecondsPerPreview: 10,
      textEmbedding: usd(0.0004),
      imageEmbedding: usd(0.00012),
    },
    budget: {
      monthlyLimit: usd(num(env.MONTHLY_BUDGET_USD, 100)),
      softLimitRatio: 0.8,
      maxItemsPerRegistry: num(env.MAX_ITEMS_PER_REGISTRY, 500),
      maxItemsPerUserPerMonth: num(env.MAX_ITEMS_PER_USER_PER_MONTH, 1000),
    },
    enrichment: {
      maxAttempts: 3,
      capturePreviews: options.previewsEnabled,
      buildVersion: BUILD_VERSION,
      captureVersion: CAPTURE_VERSION,
    },
    directoryUrl: "https://ui.shadcn.com/r/registries.json",
    syncTimeoutMs: 30 * 60 * 1000,
    // ステップごとのモデルの優先順と無料枠。docs/DESIGN.md §6.7。品質の検証は evals/models (2026-10-01)
    llm: {
      doc: list(env.OPENAI_DOC_MODELS, ["gpt-5.6-luna", "gpt-6-luna"]),
      // demo は hard tail 31 件で 5.6 (修正は 6-luna) が 6-luna 単独と同等 (24/31) だったので 5.6 を先に (evals/models/out-hard)
      demo: list(env.OPENAI_DEMO_MODELS, ["gpt-5.6-luna", "gpt-6-luna"]),
      repair: list(env.OPENAI_REPAIR_MODELS, ["gpt-6-luna", "gpt-5.6-luna"]),
      quotas: quotaGroups(env),
      useRatio: Math.min(num(env.FREE_QUOTA_RATIO, 0.9), 1),
      headroomTokens: 30_000,
      // 無料枠を使い切った後: pause (翌 UTC 日まで待つ。既定) | paid (gpt-6-luna で有料で続ける)
      overflow: env.LLM_OVERFLOW === "paid" ? { _tag: "Paid" as const, model: "gpt-6-luna" } : { _tag: "Pause" as const },
      rates: { "gpt-6-luna": rates(env, "DOC", GPT_6_LUNA), "gpt-5.6-luna": GPT_5_6_LUNA },
    },
    lifecycle: {
      resyncIntervalMs: num(env.RESYNC_INTERVAL_DAYS, 7) * 24 * 3600 * 1000,
      resyncPerRun: num(env.RESYNC_PER_RUN, 60),
      // 公式ディレクトリの自動取り込み。DIRECTORY_INTAKE=off で止める (local では既定で止める)
      directoryIntake: env.DIRECTORY_INTAKE === "on" || (env.DIRECTORY_INTAKE !== "off" && env.EXPLORER_MODE !== "local"),
      intakePerRun: num(env.DIRECTORY_INTAKE_PER_RUN, 10),
      maxBacklog: num(env.DIRECTORY_INTAKE_MAX_BACKLOG, 1000),
    },
    // registry.json でテーマが決まらないレジストリをエージェントに調べさせる (待つ間そのレジストリのプレビューは保留)
    themeAgent: options.themeAgentEnabled && env.THEME_AGENT !== "off",
    previewBuild: {
      maxRepairs: 2,
      // フォールバックの Coding Agent (CF-Open-Agents-API)。決まった手順で直せないものだけ、上限付きで回す
      agent: options.agentEnabled
        ? {
            maxPerRegistry: num(env.AGENT_MAX_PER_REGISTRY, 30),
            maxRatio: 0.25,
            monthlyBudget: usd(num(env.AGENT_MONTHLY_BUDGET_USD, 10)),
            breakerMinRuns: 10,
            breakerMinSuccessRate: 0.5,
            pollIntervalMs: 20_000,
            timeoutMs: 15 * 60_000,
          }
        : null,
    },
  })

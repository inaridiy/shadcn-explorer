import { Layer } from "effect"
import { type TokenRates, usd } from "@shadcn-explorer/core/domain"
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

const rates = (env: Env, prefix: "DOC" | "PREVIEW", fallback: TokenRates): TokenRates => ({
  inputPerMTok: num(env[`${prefix}_MODEL_INPUT_USD_PER_MTOK`], fallback.inputPerMTok),
  cachedInputPerMTok: num(env[`${prefix}_MODEL_CACHED_INPUT_USD_PER_MTOK`], fallback.cachedInputPerMTok),
  outputPerMTok: num(env[`${prefix}_MODEL_OUTPUT_USD_PER_MTOK`], fallback.outputPerMTok),
})

/**
 * 単価表と予算。docs/DESIGN.md「コスト設計」と対応する。
 * - 実コストは実トークン数 × rates で台帳に積む。…Estimate は予算判断と登録時の見積もりにだけ使う
 * - docTokensEstimate: 実測 (docs/DESIGN.md 9.2) に基づく
 * - previewTokensEstimate: サンドボックスの多ターン実行。キャッシュ率を高めに見積もる (要実測)
 * - Browser Rendering $0.09 / browser-hour、gemini-embedding-2 $0.20 / 1M text tokens・約 $0.00012 / image
 */
export const makeExplorerConfig = (env: Env, options: { readonly previewsEnabled: boolean }) =>
  Layer.succeed(ExplorerConfig, {
    prices: {
      docModel: rates(env, "DOC", GPT_6_LUNA),
      docTokensEstimate: { inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 3_000 },
      previewModel: rates(env, "PREVIEW", GPT_6_LUNA),
      previewTokensEstimate: { inputTokens: 400_000, cachedInputTokens: 300_000, outputTokens: 20_000 },
      previewSandboxEstimate: usd(0.01),
      browserPerSecond: usd(0.09 / 3600),
      browserSecondsPerPreview: 8,
      textEmbedding: usd(0.0004),
      imageEmbedding: usd(0.00012),
    },
    budget: {
      monthlyLimit: usd(num(env.MONTHLY_BUDGET_USD, 100)),
      softLimitRatio: 0.8,
      maxItemsPerRegistry: num(env.MAX_ITEMS_PER_REGISTRY, 500),
      maxItemsPerUserPerMonth: num(env.MAX_ITEMS_PER_USER_PER_MONTH, 1000),
    },
    enrichment: { maxAttempts: 3, capturePreviews: options.previewsEnabled },
    directoryUrl: "https://ui.shadcn.com/r/registries.json",
    syncTimeoutMs: 30 * 60 * 1000,
    previewBuild: { pollIntervalMs: 15_000, timeoutMs: 25 * 60 * 1000 },
  })

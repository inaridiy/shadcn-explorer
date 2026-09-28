import { Layer } from "effect"
import { usd } from "@shadcn-explorer/core/domain"
import { ExplorerConfig } from "@shadcn-explorer/core/ports"

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * 単価表と予算。docs/DESIGN.md「コスト設計」の試算と対応する。
 * - agentRunEstimate: Agent 1 実行 (約 60k in / 8k out tokens + サンドボックス数分) の見込み
 * - browserPerSecond: Browser Rendering $0.09 / browser-hour
 * - text/imageEmbedding: gemini-embedding-2 ($0.20 / 1M text tokens, 約 $0.00012 / image)
 */
export const makeExplorerConfig = (env: Env) =>
  Layer.succeed(ExplorerConfig, {
    prices: {
      agentRunEstimate: usd(0.12),
      browserPerSecond: usd(0.09 / 3600),
      browserSecondsPerPreview: 8,
      textEmbedding: usd(0.0004),
      imageEmbedding: usd(0.00012),
    },
    budget: {
      monthlyLimit: usd(num(env.MONTHLY_BUDGET_USD, 100)),
      softLimitRatio: 0.8,
      maxItemsPerRegistry: num(env.MAX_ITEMS_PER_REGISTRY, 500),
    },
    enrichment: { maxAttempts: 3, capturePreviews: true },
    directoryUrl: "https://ui.shadcn.com/r/registries.json",
    syncTimeoutMs: 30 * 60 * 1000,
  })

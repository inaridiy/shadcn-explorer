import { Data, Schema } from "effect"
import { type EnrichmentStep, isExpensiveStep } from "./enrichment.js"

/**
 * API コストのドメインモデル。
 * 浮動小数の誤差を避けるため、金額は「マイクロ USD (1e-6 USD)」の整数で扱う。
 */
export const MicroUsd = Schema.Number.pipe(Schema.int(), Schema.brand("MicroUsd"))
export type MicroUsd = typeof MicroUsd.Type

export const usd = (value: number): MicroUsd => MicroUsd.make(Math.round(value * 1_000_000))
export const toUsd = (value: MicroUsd): number => value / 1_000_000
export const addMicro = (a: MicroUsd, b: MicroUsd): MicroUsd => MicroUsd.make(a + b)

/** 課金が発生する外部リソース */
export const CostCategory = Schema.Literal("llm", "agent", "browser", "embedding", "ai-search", "vectorize")
export type CostCategory = typeof CostCategory.Type

/** LLM のトークン単価 (USD / 1M tokens) */
export interface TokenRates {
  readonly inputPerMTok: number
  readonly cachedInputPerMTok: number
  readonly outputPerMTok: number
}

export interface TokenUsage {
  readonly inputTokens: number
  /** inputTokens のうちキャッシュヒット分 */
  readonly cachedInputTokens?: number
  readonly outputTokens: number
}

/** トークン数 × 単価。キャッシュ分は安い単価で計算する */
export const llmCost = (usage: TokenUsage, rates: TokenRates): MicroUsd => {
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
  const fresh = usage.inputTokens - cached
  return usd((fresh * rates.inputPerMTok + cached * rates.cachedInputPerMTok + usage.outputTokens * rates.outputPerMTok) / 1_000_000)
}

/**
 * 単価表。モデル・プラン変更に追従できるよう設定値として注入する (env から構築)。
 * 見積もりにだけ使う値 (…Estimate) と、実測に掛ける単価 (rates) を分けて持つ。
 */
export interface PriceBook {
  /** ドキュメント生成 LLM (既定: gpt-6-luna) の単価 */
  readonly docModel: TokenRates
  /** ドキュメント 1 件あたりの見込みトークン数 */
  readonly docTokensEstimate: TokenUsage
  /** プレビュービルド (サンドボックス Agent 1 セッション) の単価と見込み */
  readonly previewModel: TokenRates
  readonly previewTokensEstimate: TokenUsage
  /** サンドボックス (コンテナ) 1 セッションあたりの固定費見込み */
  readonly previewSandboxEstimate: MicroUsd
  /** Browser Rendering 1 秒あたり */
  readonly browserPerSecond: MicroUsd
  /** 1 コンポーネントのプレビュー撮影に要する見込み秒数 (light + dark) */
  readonly browserSecondsPerPreview: number
  /** テキスト埋め込み 1 回 (ドキュメント 1 本) */
  readonly textEmbedding: MicroUsd
  /** 画像埋め込み 1 枚 */
  readonly imageEmbedding: MicroUsd
}

export const previewBuildEstimate = (prices: PriceBook): MicroUsd =>
  addMicro(llmCost(prices.previewTokensEstimate, prices.previewModel), prices.previewSandboxEstimate)

export const estimateStepCost = (step: EnrichmentStep, prices: PriceBook): MicroUsd => {
  switch (step._tag) {
    case "GenerateDoc":
      return llmCost(prices.docTokensEstimate, prices.docModel)
    case "BuildPreview":
      return previewBuildEstimate(prices)
    case "CapturePreview":
      return MicroUsd.make(Math.round(prices.browserPerSecond * prices.browserSecondsPerPreview))
    case "Index":
      return MicroUsd.make(prices.textEmbedding + (step.withImage ? prices.imageEmbedding * 2 /* light + dark */ : 0))
  }
}

export const estimatePlanCost = (steps: ReadonlyArray<EnrichmentStep>, prices: PriceBook): MicroUsd =>
  steps.reduce((sum, s) => addMicro(sum, estimateStepCost(s, prices)), MicroUsd.make(0))

/**
 * 予算 (月次)。レジストリ単位・ユーザー単位の件数上限も持ち、
 * 巨大レジストリや大量登録による課金爆発を防ぐ。
 */
export interface Budget {
  readonly monthlyLimit: MicroUsd
  /** 予算の何割を超えたら「高コストなステップ (プレビュー) を後回しにする」か */
  readonly softLimitRatio: number
  readonly maxItemsPerRegistry: number
  /** 1 ユーザーが 1 か月に登録できるアイテム数の合計 */
  readonly maxItemsPerUserPerMonth: number
}

export type BudgetDecision = Data.TaggedEnum<{
  /** そのまま実行 */
  Proceed: {}
  /** 安価なステップ (ドキュメント・インデックス) だけ実行し、プレビューは後回し */
  Degrade: { readonly allowed: ReadonlyArray<EnrichmentStep>; readonly deferred: ReadonlyArray<EnrichmentStep> }
  /** 実行しない */
  Defer: { readonly reason: string }
}>
export const BudgetDecision = Data.taggedEnum<BudgetDecision>()

/**
 * 予算に基づく実行判断 (純粋関数)。
 * - 残予算で賄えるなら Proceed
 * - ソフトリミット超過時はプレビュー (Agent ビルド + Browser) を後回しにする
 * - ハードリミット超過なら Defer
 */
export const decideBudget = (
  steps: ReadonlyArray<EnrichmentStep>,
  spentThisMonth: MicroUsd,
  budget: Budget,
  prices: PriceBook,
): BudgetDecision => {
  const cost = estimatePlanCost(steps, prices)
  if (spentThisMonth + cost > budget.monthlyLimit) {
    return BudgetDecision.Defer({ reason: "月次予算の上限に達しています" })
  }
  if (spentThisMonth + cost > budget.monthlyLimit * budget.softLimitRatio) {
    const deferred = steps.filter(isExpensiveStep)
    if (deferred.length === 0) return BudgetDecision.Proceed()
    return BudgetDecision.Degrade({ allowed: steps.filter((s) => !isExpensiveStep(s)), deferred })
  }
  return BudgetDecision.Proceed()
}

/** 実際に発生したコストの記録 (UsageLedger に積む) */
export class UsageRecord extends Schema.Class<UsageRecord>("UsageRecord")({
  category: CostCategory,
  amount: MicroUsd,
  /** 何の処理か (componentId や "search" など) */
  subject: Schema.String,
  /** コストの帰属先レジストリ (検索など特定できないものは null) */
  registryId: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null }),
  /** 実トークン数などの明細 */
  detail: Schema.Record({ key: Schema.String, value: Schema.Number }),
  at: Schema.Number,
}) {}

/** 月の開始時刻 (UTC)。月次集計のキーに使う */
export const monthStart = (now: number): number => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

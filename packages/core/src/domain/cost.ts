import { Data, Schema } from "effect"
import type { EnrichmentStep } from "./enrichment.js"

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
export const CostCategory = Schema.Literal("agent", "browser", "embedding", "ai-search", "vectorize")
export type CostCategory = typeof CostCategory.Type

/**
 * 単価表。モデル・プラン変更に追従できるよう設定値として注入する (env から構築)。
 * 値は docs/DESIGN.md の試算の前提を参照。
 */
export interface PriceBook {
  /** Coding Agent 1 実行あたりの見込み (入出力トークン + サンドボックス時間) */
  readonly agentRunEstimate: MicroUsd
  /** Browser Rendering 1 秒あたり */
  readonly browserPerSecond: MicroUsd
  /** 1 コンポーネントのプレビュー撮影に要する見込み秒数 (light + dark) */
  readonly browserSecondsPerPreview: number
  /** テキスト埋め込み 1 回 (ドキュメント 1 本) */
  readonly textEmbedding: MicroUsd
  /** 画像埋め込み 1 枚 */
  readonly imageEmbedding: MicroUsd
}

export const estimateStepCost = (step: EnrichmentStep, prices: PriceBook): MicroUsd => {
  switch (step._tag) {
    case "GenerateDoc":
      return prices.agentRunEstimate
    case "CapturePreview":
      return MicroUsd.make(Math.round(prices.browserPerSecond * prices.browserSecondsPerPreview))
    case "Index":
      return MicroUsd.make(
        prices.textEmbedding + (step.withImage ? prices.imageEmbedding * 2 /* light + dark */ : 0),
      )
  }
}

export const estimatePlanCost = (steps: ReadonlyArray<EnrichmentStep>, prices: PriceBook): MicroUsd =>
  steps.reduce((sum, s) => addMicro(sum, estimateStepCost(s, prices)), MicroUsd.make(0))

/** 予算 (月次)。レジストリ単位のアイテム上限も持ち、巨大レジストリ登録による課金爆発を防ぐ。 */
export interface Budget {
  readonly monthlyLimit: MicroUsd
  /** 予算の何割を超えたら「高コストなステップ (Agent) を後回しにする」か */
  readonly softLimitRatio: number
  readonly maxItemsPerRegistry: number
}

export type BudgetDecision = Data.TaggedEnum<{
  /** そのまま実行 */
  Proceed: {}
  /** 安価なステップ (インデックス) だけ実行し、高価なものは翌月以降に回す */
  Degrade: { readonly allowed: ReadonlyArray<EnrichmentStep>; readonly deferred: ReadonlyArray<EnrichmentStep> }
  /** 実行しない */
  Defer: { readonly reason: string }
}>
export const BudgetDecision = Data.taggedEnum<BudgetDecision>()

/**
 * 予算に基づく実行判断 (純粋関数)。
 * - 残予算で賄えるなら Proceed
 * - ソフトリミット超過時は Agent/Browser を後回しにして Index (安い) だけ回す
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
  const soft = budget.monthlyLimit * budget.softLimitRatio
  if (spentThisMonth + cost > soft) {
    const allowed = steps.filter((s) => s._tag === "Index")
    const deferred = steps.filter((s) => s._tag !== "Index")
    if (deferred.length === 0) return BudgetDecision.Proceed()
    return BudgetDecision.Degrade({ allowed, deferred })
  }
  return BudgetDecision.Proceed()
}

/** 実際に発生したコストの記録 (UsageLedger に積む) */
export class UsageRecord extends Schema.Class<UsageRecord>("UsageRecord")({
  category: CostCategory,
  amount: MicroUsd,
  /** 何の処理か (componentId や "search" など) */
  subject: Schema.String,
  /** 実トークン数などの明細 */
  detail: Schema.Record({ key: Schema.String, value: Schema.Number }),
  at: Schema.Number,
}) {}

/** 月の開始時刻 (UTC)。月次集計のキーに使う */
export const monthStart = (now: number): number => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

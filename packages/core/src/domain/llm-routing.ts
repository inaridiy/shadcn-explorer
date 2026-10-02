import type { TokenRates } from "./cost.js"

/**
 * LLM のモデル選択と、OpenAI の無料枠 (Complimentary daily tokens) の使い方 (v0.7)。
 *
 * 無料枠はモデル群ごとに 1 日 (00:00 UTC リセット) のトークン数で決まる (例: gpt-6-luna の群 1M、gpt-5.6-luna の群 10M)。
 * input と output (reasoning 込み) を数え、上限をまたいだリクエストは全体が通常料金になる。
 * そこで「その日の使用量 + 余裕 (1 リクエストの最大) ≤ 上限 × useRatio」の間だけ無料として使い、超えたら:
 *   - Pause: 次の UTC 日まで待つ (エンリッチを後回しにし、backlog sweeper が拾い直す)
 *   - Paid:  指定モデルで通常料金で続ける
 */
export interface QuotaGroup {
  readonly name: string
  readonly models: ReadonlyArray<string>
  readonly dailyTokens: number
}

export type QuotaOverflow = { readonly _tag: "Pause" } | { readonly _tag: "Paid"; readonly model: string }

export interface LlmRouting {
  /** ステップごとのモデルの優先順。先頭から無料枠が残っているものを使う */
  readonly doc: ReadonlyArray<string>
  readonly demo: ReadonlyArray<string>
  readonly repair: ReadonlyArray<string>
  readonly quotas: ReadonlyArray<QuotaGroup>
  /** 無料枠のうち使う割合 (0.9 = 9 割で止める) */
  readonly useRatio: number
  /** 1 リクエストの最大トークン数の見込み。上限をまたぐと全額課金なので、この分を残して止める */
  readonly headroomTokens: number
  readonly overflow: QuotaOverflow
  /** モデルごとの単価 (有料で使ったときの記録用) */
  readonly rates: Readonly<Record<string, TokenRates>>
}

export type ModelChoice =
  | { readonly _tag: "Use"; readonly model: string; readonly free: boolean }
  | { readonly _tag: "Wait"; readonly reason: string }

export const quotaGroupOf = (routing: LlmRouting, model: string): QuotaGroup | undefined =>
  routing.quotas.find((g) => g.models.includes(model))

/** その日の群ごとの使用量 (モデル別の合計から集計) */
export const usageByGroup = (routing: LlmRouting, tokensByModel: ReadonlyMap<string, number>): ReadonlyMap<string, number> => {
  const out = new Map<string, number>()
  for (const [model, tokens] of tokensByModel) {
    const group = quotaGroupOf(routing, model)
    if (group) out.set(group.name, (out.get(group.name) ?? 0) + tokens)
  }
  return out
}

/** 優先順に、無料枠が残っているモデルを選ぶ。無料枠の設定が無いモデルは有料としてそのまま使う */
export const chooseModel = (
  preferences: ReadonlyArray<string>,
  routing: LlmRouting,
  tokensByModel: ReadonlyMap<string, number>,
): ModelChoice => {
  const used = usageByGroup(routing, tokensByModel)
  for (const model of preferences) {
    const group = quotaGroupOf(routing, model)
    if (!group) return { _tag: "Use", model, free: false }
    if ((used.get(group.name) ?? 0) + routing.headroomTokens <= group.dailyTokens * routing.useRatio) {
      return { _tag: "Use", model, free: true }
    }
  }
  return routing.overflow._tag === "Paid"
    ? { _tag: "Use", model: routing.overflow.model, free: false }
    : { _tag: "Wait", reason: "today's free LLM quota is used up" }
}

/** UTC の日の始まり (無料枠のリセット) */
export const utcDayStart = (now: number): number => {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

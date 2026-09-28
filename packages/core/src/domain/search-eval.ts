import type { ComponentId } from "./ids.js"

/**
 * 検索品質の評価 (オフライン評価用の純粋関数)。
 * ゴールデンセット (クエリ → 正解コンポーネント集合) に対して recall@k と MRR を計算し、
 * バックエンド単体・融合後のどれが効いているかを数値で比較する。
 */
export interface GoldenQuery {
  readonly query: string
  readonly relevant: ReadonlyArray<ComponentId>
  /** 任意のタグ (例: "ja", "visual", "exact-name") で集計を分ける */
  readonly tags?: ReadonlyArray<string>
}

export interface QueryEvaluation {
  readonly query: string
  readonly recallAtK: number
  readonly reciprocalRank: number
  readonly firstRelevantRank: number | null
}

export interface EvaluationSummary {
  readonly k: number
  readonly queries: number
  readonly meanRecallAtK: number
  readonly mrr: number
  readonly perQuery: ReadonlyArray<QueryEvaluation>
}

export const evaluateQuery = (
  golden: GoldenQuery,
  ranked: ReadonlyArray<ComponentId>,
  k: number,
): QueryEvaluation => {
  const relevant = new Set(golden.relevant)
  const top = ranked.slice(0, k)
  const hits = top.filter((id) => relevant.has(id)).length
  const firstIndex = ranked.findIndex((id) => relevant.has(id))
  return {
    query: golden.query,
    recallAtK: relevant.size === 0 ? 0 : hits / relevant.size,
    reciprocalRank: firstIndex === -1 ? 0 : 1 / (firstIndex + 1),
    firstRelevantRank: firstIndex === -1 ? null : firstIndex + 1,
  }
}

export const summarizeEvaluation = (
  results: ReadonlyArray<{ readonly golden: GoldenQuery; readonly ranked: ReadonlyArray<ComponentId> }>,
  k = 10,
): EvaluationSummary => {
  const perQuery = results.map((r) => evaluateQuery(r.golden, r.ranked, k))
  const mean = (xs: ReadonlyArray<number>) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
  return {
    k,
    queries: perQuery.length,
    meanRecallAtK: mean(perQuery.map((q) => q.recallAtK)),
    mrr: mean(perQuery.map((q) => q.reciprocalRank)),
    perQuery,
  }
}

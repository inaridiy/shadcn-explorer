import { Schema } from "effect"
import { ComponentKind } from "./component.js"
import { ComponentId, RegistryId } from "./ids.js"

/**
 * 検索モード。
 * - keyword : D1 FTS5 の BM25。型番・パッケージ名・固有名詞に強い
 * - semantic: Cloudflare AI Search (テキスト意味検索)
 * - visual  : Gemini マルチモーダル埋め込み (テキスト → スクショ、画像 → スクショ)
 * - hybrid  : 上記を Reciprocal Rank Fusion で融合 (既定)
 */
export const SearchMode = Schema.Literal("hybrid", "keyword", "semantic", "visual")
export type SearchMode = typeof SearchMode.Type

export const SearchFilters = Schema.Struct({
  registryIds: Schema.optional(Schema.Array(RegistryId)),
  kinds: Schema.optional(Schema.Array(ComponentKind)),
})
export type SearchFilters = typeof SearchFilters.Type

/** 検索クエリ (直和型)。画像検索はアップロード済み画像のオブジェクトキーで受ける。 */
export const SearchQuery = Schema.Union(
  Schema.TaggedStruct("Text", {
    text: Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(500)),
    mode: SearchMode,
    filters: SearchFilters,
    limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
  }),
  Schema.TaggedStruct("Image", {
    imageKey: Schema.String,
    filters: SearchFilters,
    limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 100)),
  }),
)
export type SearchQuery = typeof SearchQuery.Type

export const SearchSource = Schema.Literal("keyword", "semantic", "visual-text", "visual-image")
export type SearchSource = typeof SearchSource.Type

/** 各バックエンドが返すランキング (順位だけが意味を持つ。スコアのスケールはバックエンド毎に異なる) */
export interface RankedList {
  readonly source: SearchSource
  readonly ids: ReadonlyArray<ComponentId>
  /** 融合時の重み (既定 1) */
  readonly weight?: number
}

export class FusedHit extends Schema.Class<FusedHit>("FusedHit")({
  componentId: ComponentId,
  score: Schema.Number,
  sources: Schema.Array(SearchSource),
}) {}

/**
 * Reciprocal Rank Fusion。スケールの異なるランキングを順位だけで融合する。
 *   score(d) = Σ_i  w_i / (k + rank_i(d))
 * k=60 は Cormack et al. (2009) の推奨値。
 */
export const reciprocalRankFusion = (
  lists: ReadonlyArray<RankedList>,
  options: { readonly k?: number; readonly limit?: number } = {},
): ReadonlyArray<FusedHit> => {
  const k = options.k ?? 60
  const acc = new Map<ComponentId, { score: number; sources: Set<SearchSource>; firstSeen: number }>()
  let order = 0
  for (const list of lists) {
    const w = list.weight ?? 1
    const seenInList = new Set<ComponentId>()
    list.ids.forEach((id, index) => {
      if (seenInList.has(id)) return
      seenInList.add(id)
      const entry = acc.get(id) ?? { score: 0, sources: new Set<SearchSource>(), firstSeen: order++ }
      entry.score += w / (k + index + 1)
      entry.sources.add(list.source)
      acc.set(id, entry)
    })
  }
  const hits = [...acc.entries()]
    .sort(([, a], [, b]) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map(([componentId, e]) => new FusedHit({ componentId, score: e.score, sources: [...e.sources] }))
  return options.limit !== undefined ? hits.slice(0, options.limit) : hits
}

/** モード毎にどのバックエンドを使うか */
export const sourcesForMode = (mode: SearchMode): ReadonlyArray<"keyword" | "semantic" | "visual"> => {
  switch (mode) {
    case "keyword":
      return ["keyword"]
    case "semantic":
      return ["semantic"]
    case "visual":
      return ["visual"]
    case "hybrid":
      return ["keyword", "semantic", "visual"]
  }
}

/**
 * FTS5 の MATCH 構文に安全に渡せるようクエリを正規化する。
 * ユーザー入力の演算子 (AND/OR/NEAR/*, ", :) は無効化し、各トークンをフレーズ化して前方一致させる。
 */
export const toFtsQuery = (text: string): string | null => {
  const tokens = text
    .normalize("NFKC")
    .split(/[\s　]+/)
    .map((t) => t.replace(/["*:^(){}[\]]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, 12)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(" OR ")
}

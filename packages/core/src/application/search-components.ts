import { Data, Effect, Either, Option } from "effect"
import {
  type ComponentId,
  type FusedHit,
  type RankedList,
  type SearchFilters,
  type SearchQuery,
  type SearchSource,
  reciprocalRankFusion,
  sourcesForMode,
} from "../domain/index.js"
import {
  BlobStore,
  type ComponentCard,
  ComponentRepository,
  Embedder,
  type EmbeddingError,
  type IndexFilters,
  type SearchBackendError,
  TextSearchIndex,
  VectorIndex,
} from "../ports/index.js"

export class SearchImageNotFound extends Data.TaggedError("SearchImageNotFound")<{
  readonly imageKey: string
}> {}

export interface SearchHitView {
  readonly card: ComponentCard
  readonly score: number
  readonly sources: ReadonlyArray<SearchSource>
}

export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHitView>
  /** 一部のバックエンドが失敗しても結果は返す (劣化運転)。その理由 */
  readonly warnings: ReadonlyArray<string>
}

/** 融合で使う各ソースの重み。キーワードは固有名詞に強いので少し高め */
const WEIGHTS: Record<SearchSource, number> = {
  keyword: 1.2,
  semantic: 1,
  "visual-text": 0.9,
  "visual-image": 1,
}

const toIndexFilters = (filters: SearchFilters): IndexFilters => ({
  ...(filters.registryIds ? { registryIds: filters.registryIds } : {}),
  ...(filters.kinds ? { kinds: filters.kinds } : {}),
})

const ranked = (source: SearchSource, ids: ReadonlyArray<ComponentId>): RankedList => ({
  source,
  ids,
  weight: WEIGHTS[source],
})

const hydrate = (hits: ReadonlyArray<FusedHit>, filters: SearchFilters) =>
  Effect.gen(function* () {
    const repo = yield* ComponentRepository
    // カードだけを引く (JSON 全体のデコードは検索の待ち時間の大半を占めていた)
    const cards = yield* repo.findCards(hits.map((h) => h.componentId))
    const byId = new Map(cards.map((c) => [c.id, c]))
    return hits.flatMap((h): Array<SearchHitView> => {
      const card = byId.get(h.componentId)
      if (!card) return [] // インデックスにだけ残っている削除済みアイテム
      if (filters.kinds && !filters.kinds.includes(card.kind)) return []
      if (filters.registryIds && !filters.registryIds.includes(card.registryId)) return []
      return [{ card, score: h.score, sources: h.sources }]
    })
  })

/**
 * テキストクエリ。
 * - keyword : BM25 (D1 FTS5 / AI Search)
 * - semantic: クエリ埋め込み × ドキュメントベクトル (modality=doc)
 * - visual  : 同じクエリ埋め込み × スクショベクトル (modality=light/dark)
 * 埋め込みは 1 回だけ計算して semantic / visual で共有する。
 */
const textQuery = (query: Extract<SearchQuery, { _tag: "Text" }>) =>
  Effect.gen(function* () {
    const textIndex = yield* TextSearchIndex
    const vectorIndex = yield* VectorIndex
    const embedder = yield* Embedder
    const filters = toIndexFilters(query.filters)
    const fetchLimit = Math.min(query.limit * 2, 50)
    const backends = sourcesForMode(query.mode)

    const needsVector = backends.some((b) => b !== "keyword")
    const embedded = needsVector ? yield* Effect.either(embedder.embedQuery(query.text)) : null

    const tasks = backends.map((backend): Effect.Effect<RankedList, SearchBackendError | EmbeddingError> => {
      switch (backend) {
        case "keyword":
          return textIndex.search(query.text, filters, fetchLimit).pipe(Effect.map((ids) => ranked("keyword", ids)))
        case "semantic":
        case "visual": {
          if (embedded === null) return Effect.succeed(ranked("semantic", []))
          if (embedded._tag === "Left") return Effect.fail(embedded.left)
          const modalities = backend === "semantic" ? (["doc"] as const) : (["light", "dark"] as const)
          return vectorIndex
            .query(embedded.right, { ...filters, modalities }, fetchLimit)
            .pipe(Effect.map((ids) => ranked(backend === "semantic" ? "semantic" : "visual-text", ids)))
        }
      }
    })
    const results = yield* Effect.all(tasks.map(Effect.either), { concurrency: "unbounded" })
    // 埋め込み失敗は semantic / visual の両方で同じ警告になるので 1 つにまとめる
    return embedded?._tag === "Left"
      ? [...results.filter((r) => r._tag === "Right"), Either.left(embedded.left)]
      : results
  })

const imageQuery = (query: Extract<SearchQuery, { _tag: "Image" }>) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const embedder = yield* Embedder
    const vectorIndex = yield* VectorIndex
    const image = yield* blobs.get(query.imageKey)
    if (Option.isNone(image)) return yield* new SearchImageNotFound({ imageKey: query.imageKey })
    const result = yield* embedder.embedImage(image.value).pipe(
      Effect.flatMap((v) =>
        vectorIndex.query(v, { ...toIndexFilters(query.filters), modalities: ["light", "dark"] }, Math.min(query.limit * 2, 50)),
      ),
      Effect.map((ids) => ranked("visual-image", ids)),
      Effect.either,
    )
    return [result]
  })

/**
 * 横断検索ユースケース。
 * 各バックエンドを並列に叩き、失敗したものは warnings に積んで残りで RRF 融合する。
 */
export const searchComponents = (query: SearchQuery) =>
  Effect.gen(function* () {
    const results = query._tag === "Text" ? yield* textQuery(query) : yield* imageQuery(query)
    const lists: Array<RankedList> = []
    const warnings: Array<string> = []
    for (const r of results) {
      if (r._tag === "Right") lists.push(r.right)
      else warnings.push(`${r.left._tag}: ${r.left.reason}`)
    }
    const fused = reciprocalRankFusion(lists, { limit: query.limit })
    const hits = yield* hydrate(fused, query.filters)
    return { hits, warnings } satisfies SearchResult
  }).pipe(Effect.withSpan("searchComponents", { attributes: { tag: query._tag } }))

/**
 * 「よそで似ているもの」: そのコンポーネントのスクショのベクトル (light / dark) を起点に、
 * 他のレジストリから見た目の近いものを返す。同じモダリティ同士で引き (ライトはライトと比べる)、RRF で融合する。
 * 埋め込みは保存済みのものを使うので、Embedder は呼ばない (追加の費用がかからない)。
 * スクショの無いコンポーネント (hook など) は空を返す。
 */
export const similarComponents = (id: ComponentId, limit = 8) =>
  Effect.gen(function* () {
    const vectorIndex = yield* VectorIndex
    const own = yield* vectorIndex.vectorsOf(id, ["light", "dark"])
    if (own.length === 0) return [] as ReadonlyArray<ComponentCard>
    const registryId = own[0]!.registryId
    const lists = yield* Effect.forEach(
      own,
      (v) =>
        vectorIndex
          .query(v.values, { modalities: [v.modality], excludeRegistryIds: [registryId] }, Math.min(limit * 2, 20))
          .pipe(Effect.map((ids) => ranked("visual-image", ids))),
      { concurrency: "unbounded" },
    )
    // バックエンドが除外フィルタを無視しても、自分と同じレジストリは出さない
    const ids = reciprocalRankFusion(lists)
      .map((h) => h.componentId)
      .filter((c) => c !== id && !c.startsWith(`${registryId}:`))
      .slice(0, limit)
    if (ids.length === 0) return [] as ReadonlyArray<ComponentCard>
    const cards = yield* (yield* ComponentRepository).findCards(ids)
    const byId = new Map(cards.map((c) => [c.id, c]))
    // 順位を保ったまま、スクショのあるものだけ (インデックスにだけ残っている削除済みアイテムも落ちる)
    return ids.flatMap((c) => {
      const card = byId.get(c)
      return card && card.stills ? [card] : []
    })
  }).pipe(Effect.withSpan("similarComponents", { attributes: { componentId: id } }))

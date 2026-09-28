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
  type ComponentRecord,
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
  readonly record: ComponentRecord
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
    const records = yield* repo.findMany(hits.map((h) => h.componentId))
    const byId = new Map(records.map((r) => [r.snapshot.id, r]))
    return hits.flatMap((h): Array<SearchHitView> => {
      const record = byId.get(h.componentId)
      if (!record) return [] // インデックスにだけ残っている削除済みアイテム
      if (filters.kinds && !filters.kinds.includes(record.snapshot.kind)) return []
      if (filters.registryIds && !filters.registryIds.includes(record.snapshot.registryId)) return []
      return [{ record, score: h.score, sources: h.sources }]
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

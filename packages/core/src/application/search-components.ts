import { Data, Effect, Option } from "effect"
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
  type IndexFilters,
  TextSearchIndex,
  VisualIndex,
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

const textQuery = (query: Extract<SearchQuery, { _tag: "Text" }>) =>
  Effect.gen(function* () {
    const textIndex = yield* TextSearchIndex
    const visualIndex = yield* VisualIndex
    const embedder = yield* Embedder
    const filters = toIndexFilters(query.filters)
    const fetchLimit = Math.min(query.limit * 2, 50)

    const tasks = sourcesForMode(query.mode).map((backend) => {
      switch (backend) {
        case "keyword":
          return textIndex.search(query.text, "keyword", filters, fetchLimit).pipe(Effect.map((ids) => ranked("keyword", ids)))
        case "semantic":
          return textIndex.search(query.text, "vector", filters, fetchLimit).pipe(Effect.map((ids) => ranked("semantic", ids)))
        case "visual":
          return embedder.embedQuery(query.text).pipe(
            Effect.flatMap((v) => visualIndex.query(v, filters, fetchLimit)),
            Effect.map((ids) => ranked("visual-text", ids)),
          )
      }
    })
    return yield* Effect.all(tasks.map(Effect.either), { concurrency: "unbounded" })
  })

const imageQuery = (query: Extract<SearchQuery, { _tag: "Image" }>) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const embedder = yield* Embedder
    const visualIndex = yield* VisualIndex
    const image = yield* blobs.get(query.imageKey)
    if (Option.isNone(image)) return yield* new SearchImageNotFound({ imageKey: query.imageKey })
    const result = yield* embedder.embedImage(image.value).pipe(
      Effect.flatMap((v) => visualIndex.query(v, toIndexFilters(query.filters), Math.min(query.limit * 2, 50))),
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

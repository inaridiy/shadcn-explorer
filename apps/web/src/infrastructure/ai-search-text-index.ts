import { Effect, Layer } from "effect"
import type { ComponentId } from "@shadcn-explorer/core/domain"
import { type IndexFilters, SearchBackendError, TextSearchIndex } from "@shadcn-explorer/core/ports"

/**
 * Cloudflare AI Search (旧 AutoRAG) を使ったテキスト検索。
 * インスタンスは「組み込みストレージ + Items API」で作成し、
 *   index_method: { vector: true, keyword: true }  (ハイブリッド: BM25 + ベクトル)
 *   indexing_options.keyword_tokenizer: "trigram"   (日本語の部分一致)
 *   embedding_model: "google-ai-studio/gemini-embedding-001"
 *   custom_metadata: component_id / registry_id / kind
 * を設定しておく (scripts/setup-cloudflare.md 参照)。
 */
const itemKey = (id: ComponentId) => `${id.replace(":", "__")}.md`

export const toVectorizeFilter = (filters: IndexFilters): VectorizeVectorMetadataFilter => ({
  ...(filters.registryIds?.length ? { registry_id: { $in: [...filters.registryIds] } } : {}),
  ...(filters.kinds?.length ? { kind: { $in: [...filters.kinds] } } : {}),
})

const fail = (reason: unknown) => new SearchBackendError({ backend: "ai-search", reason: String(reason).slice(0, 300) })

export const AiSearchTextIndex = (instance: AiSearchInstance) =>
  Layer.succeed(TextSearchIndex, {
    upsert: (doc) =>
      Effect.tryPromise({
        // 同じ名前でのアップロードは同一アイテムの更新として扱われる
        try: () =>
          instance.items.upload(itemKey(doc.componentId), doc.markdown, {
            metadata: { component_id: doc.componentId, registry_id: doc.registryId, kind: doc.kind },
          }),
        catch: fail,
      }).pipe(Effect.asVoid),
    remove: (ids) =>
      Effect.forEach(
        ids,
        (id) =>
          Effect.tryPromise({
            try: async () => {
              const { result } = await instance.items.list({ key: itemKey(id) })
              await Promise.all(result.map((item) => instance.items.delete(item.id)))
            },
            catch: fail,
          }),
        { concurrency: 4, discard: true },
      ),
    search: (text, retrieval, filters, limit) =>
      Effect.tryPromise({
        try: () =>
          instance.search({
            query: text,
            ai_search_options: {
              retrieval: {
                retrieval_type: retrieval,
                max_num_results: Math.min(limit, 50),
                keyword_match_mode: "or",
                filters: toVectorizeFilter(filters),
              },
              query_rewrite: { enabled: false },
              reranking: { enabled: false },
            },
          }),
        catch: fail,
      }).pipe(
        Effect.map(({ chunks }) => {
          // チャンク単位で返るのでコンポーネント単位に畳む (順位は最初の出現)
          const ids: Array<ComponentId> = []
          for (const chunk of chunks) {
            const id = (chunk.item.metadata?.component_id as string | undefined) ??
              chunk.item.key.replace(/\.md$/, "").replace("__", ":")
            if (!ids.includes(id as ComponentId)) ids.push(id as ComponentId)
          }
          return ids
        }),
      ),
  })

import { Effect, Layer } from "effect"
import type { ComponentId } from "@shadcn-explorer/core/domain"
import { SearchBackendError, VisualIndex, type VisualModality } from "@shadcn-explorer/core/ports"
import { toVectorizeFilter } from "./ai-search-text-index"

const MODALITIES: ReadonlyArray<VisualModality> = ["doc", "light", "dark"]

/** Vectorize の ID は 64 バイト上限なので、コンポーネント ID をハッシュ化して使う */
const vectorId = async (componentId: ComponentId, modality: VisualModality) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(componentId))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 40)}:${modality}`
}

const fail = (reason: unknown) => new SearchBackendError({ backend: "vectorize", reason: String(reason).slice(0, 300) })

/**
 * Vectorize (cosine, 1536 次元) によるマルチモーダル検索。
 * 1 コンポーネントにつき doc (テキスト) / light / dark (スクショ) の最大 3 ベクトル。
 * メタデータインデックス: registry_id, kind (wrangler vectorize create-metadata-index)
 */
export const VectorizeVisualIndex = (index: VectorizeIndex) =>
  Layer.succeed(VisualIndex, {
    upsert: (vectors) =>
      Effect.tryPromise({
        try: async () =>
          index.upsert(
            await Promise.all(
              vectors.map(async (v) => ({
                id: await vectorId(v.componentId, v.modality),
                values: [...v.values],
                metadata: { component_id: v.componentId, registry_id: v.registryId, kind: v.kind, modality: v.modality },
              })),
            ),
          ),
        catch: fail,
      }).pipe(Effect.asVoid),
    remove: (ids) =>
      Effect.tryPromise({
        try: async () => {
          const vectorIds = await Promise.all(ids.flatMap((id) => MODALITIES.map((m) => vectorId(id, m))))
          for (let i = 0; i < vectorIds.length; i += 500) await index.deleteByIds(vectorIds.slice(i, i + 500))
        },
        catch: fail,
      }),
    query: (vector, filters, limit) =>
      Effect.tryPromise({
        try: () =>
          index.query([...vector], {
            topK: Math.min(limit * 2, 50),
            returnMetadata: "all",
            filter: toVectorizeFilter(filters),
          }),
        catch: fail,
      }).pipe(
        Effect.map(({ matches }) => {
          const ids: Array<ComponentId> = []
          for (const m of matches) {
            const id = m.metadata?.component_id as ComponentId | undefined
            if (id && !ids.includes(id)) ids.push(id)
          }
          return ids.slice(0, limit)
        }),
      ),
  })

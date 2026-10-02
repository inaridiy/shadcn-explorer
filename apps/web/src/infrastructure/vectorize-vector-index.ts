import { Effect, Layer } from "effect"
import type { ComponentId, ComponentKind, RegistryId } from "@shadcn-explorer/core/domain"
import { type ComponentVector, SearchBackendError, VectorIndex, type VectorFilters, type VectorModality } from "@shadcn-explorer/core/ports"
import { toVectorizeFilter } from "./ai-search-text-index"

const MODALITIES: ReadonlyArray<VectorModality> = ["doc", "light", "dark"]

/** Vectorize の ID は 64 バイト上限なので、コンポーネント ID をハッシュ化して使う */
const vectorId = async (componentId: ComponentId, modality: VectorModality) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(componentId))
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 40)}:${modality}`
}

/**
 * registry_id の条件。含める ($in) と除外 ($nin) は同じキーに並べられないので、
 * 両方あるときは含める側から除外分を引いておく
 */
const registryFilter = (filters: VectorFilters): VectorizeVectorMetadataFilter => {
  const exclude = filters.excludeRegistryIds ?? []
  if (filters.registryIds?.length) {
    return { ...toVectorizeFilter(filters), registry_id: { $in: filters.registryIds.filter((r) => !exclude.includes(r)) } }
  }
  return exclude.length > 0 ? { ...toVectorizeFilter(filters), registry_id: { $nin: [...exclude] } } : toVectorizeFilter(filters)
}

const fail = (reason: unknown) => new SearchBackendError({ backend: "vectorize", reason: String(reason).slice(0, 300) })

/**
 * Vectorize (cosine, 1536 次元) によるマルチモーダル検索。
 * 1 コンポーネントにつき doc (テキスト) / light / dark (スクショ) の最大 3 ベクトル。
 * メタデータインデックス: registry_id, kind, modality (wrangler vectorize create-metadata-index)
 * modality で絞ることで、意味検索 (doc) とビジュアル検索 (スクショ) を別のランキングとして取り出す。
 */
export const VectorizeVectorIndex = (index: VectorizeIndex) =>
  Layer.succeed(VectorIndex, {
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
            filter: { ...registryFilter(filters), modality: { $in: [...filters.modalities] } },
          }),
        catch: fail,
      }).pipe(
        Effect.map(({ matches }) => {
          const ids: Array<ComponentId> = []
          for (const m of matches) {
            const id = m.metadata?.component_id as ComponentId | undefined
            if (filters.excludeRegistryIds?.includes(m.metadata?.registry_id as RegistryId)) continue
            if (id && !ids.includes(id)) ids.push(id)
          }
          return ids.slice(0, limit)
        }),
      ),
    // ID はハッシュから決まるので、getByIds で値とメタデータをそのまま引ける
    vectorsOf: (componentId, modalities) =>
      Effect.tryPromise({
        try: async () => index.getByIds(await Promise.all(modalities.map((m) => vectorId(componentId, m)))),
        catch: fail,
      }).pipe(
        Effect.map((found) =>
          found.flatMap((v): Array<ComponentVector> => {
            const meta = v.metadata ?? {}
            const modality = meta.modality as VectorModality | undefined
            if (!modality || !modalities.includes(modality)) return []
            return [
              {
                componentId,
                registryId: meta.registry_id as RegistryId,
                kind: meta.kind as ComponentKind,
                modality,
                values: Array.from(v.values),
              },
            ]
          }),
        ),
      ),
  })

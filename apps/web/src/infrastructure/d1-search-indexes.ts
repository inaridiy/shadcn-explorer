import { Effect, Layer } from "effect"
import type { ComponentId } from "@shadcn-explorer/core/domain"
import {
  type IndexFilters,
  SearchBackendError,
  TextSearchIndex,
  VectorIndex,
} from "@shadcn-explorer/core/ports"
import { placeholders } from "./d1"

const fail = (backend: string) => (reason: unknown) =>
  new SearchBackendError({ backend, reason: String(reason).slice(0, 300) })

const filterSql = (filters: IndexFilters) => {
  const where: Array<string> = []
  const binds: Array<string> = []
  if (filters.registryIds?.length) {
    where.push(`registry_id in (${placeholders(filters.registryIds.length)})`)
    binds.push(...filters.registryIds)
  }
  if (filters.kinds?.length) {
    where.push(`kind in (${placeholders(filters.kinds.length)})`)
    binds.push(...filters.kinds)
  }
  return { where, binds }
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/

/** 日本語など空白で区切られない語は、3 文字の窓に分けて部分一致させる ("ドット絵のボタン" → ドット, ット絵, …, ボタン) */
const trigramWindows = (token: string): Array<string> => {
  const chars = [...token]
  if (!CJK.test(token) || chars.length <= 3) return [token]
  return Array.from({ length: chars.length - 2 }, (_, i) => chars.slice(i, i + 3).join(""))
}

/**
 * trigram トークナイザ用の MATCH クエリ。3 文字未満の語は trigram で引けないので落とす。
 * ユーザー入力の FTS 演算子は全てフレーズ化して無効化し、各語を OR で繋ぐ (BM25 が一致数で順位付けする)。
 */
export const toTrigramQuery = (text: string): string | null => {
  const tokens = text
    .normalize("NFKC")
    .split(/[\s\u3000]+/)
    .map((t) => t.replace(/"/g, "").trim())
    .flatMap(trigramWindows)
    .filter((t) => [...t].length >= 3)
  const unique = [...new Set(tokens)].slice(0, 24)
  return unique.length > 0 ? unique.map((t) => `"${t}"`).join(" OR ") : null
}

/** D1 FTS5 (bm25) によるキーワード検索。既定の TextSearchIndex */
export const D1FtsTextIndex = (db: D1Database) =>
  Layer.succeed(TextSearchIndex, {
    upsert: (doc) =>
      Effect.tryPromise({
        try: () =>
          db.batch([
            db.prepare(`delete from component_fts where component_id = ?`).bind(doc.componentId),
            db
              .prepare(`insert into component_fts (component_id, registry_id, kind, body) values (?, ?, ?, ?)`)
              .bind(doc.componentId, doc.registryId, doc.kind, doc.markdown),
          ]),
        catch: fail("d1-fts"),
      }).pipe(Effect.asVoid),
    remove: (ids) =>
      ids.length === 0
        ? Effect.void
        : Effect.tryPromise({
            try: () => db.prepare(`delete from component_fts where component_id in (${placeholders(ids.length)})`).bind(...ids).run(),
            catch: fail("d1-fts"),
          }).pipe(Effect.asVoid),
    search: (text, filters, limit) => {
      const match = toTrigramQuery(text)
      if (match === null) return Effect.succeed([])
      const { where, binds } = filterSql(filters)
      return Effect.tryPromise({
        try: () =>
          db
            .prepare(
              `select component_id from component_fts
               where component_fts match ? ${where.map((w) => `and ${w}`).join(" ")}
               order by bm25(component_fts) limit ?`,
            )
            .bind(match, ...binds, limit)
            .all<{ component_id: ComponentId }>(),
        catch: fail("d1-fts"),
      }).pipe(Effect.map(({ results }) => results.map((r) => r.component_id)))
    },
  })

/** ローカル開発用: D1 に保存したベクトルを総当たりでコサイン類似度検索する */
export const D1LocalVectorIndex = (db: D1Database) =>
  Layer.succeed(VectorIndex, {
    upsert: (vectors) =>
      vectors.length === 0
        ? Effect.void
        : Effect.tryPromise({
            try: () =>
              db.batch(
                vectors.map((v) =>
                  db
                    .prepare(
                      `insert into local_vectors (id, component_id, registry_id, kind, modality, vector) values (?, ?, ?, ?, ?, ?)
                       on conflict (id) do update set vector = excluded.vector, kind = excluded.kind`,
                    )
                    .bind(`${v.componentId}#${v.modality}`, v.componentId, v.registryId, v.kind, v.modality, JSON.stringify(v.values)),
                ),
              ),
            catch: fail("d1-vectors"),
          }).pipe(Effect.asVoid),
    remove: (ids) =>
      ids.length === 0
        ? Effect.void
        : Effect.tryPromise({
            try: () => db.prepare(`delete from local_vectors where component_id in (${placeholders(ids.length)})`).bind(...ids).run(),
            catch: fail("d1-vectors"),
          }).pipe(Effect.asVoid),
    query: (vector, filters, limit) => {
      const { where, binds } = filterSql(filters)
      where.push(`modality in (${placeholders(filters.modalities.length)})`)
      binds.push(...filters.modalities)
      return Effect.tryPromise({
        try: () =>
          db
            .prepare(`select component_id, vector from local_vectors ${where.length ? `where ${where.join(" and ")}` : ""}`)
            .bind(...binds)
            .all<{ component_id: ComponentId; vector: string }>(),
        catch: fail("d1-vectors"),
      }).pipe(
        Effect.map(({ results }) => {
          const best = new Map<ComponentId, number>()
          for (const row of results) {
            const values = JSON.parse(row.vector) as Array<number>
            let dot = 0
            for (let i = 0; i < Math.min(values.length, vector.length); i++) dot += values[i]! * vector[i]!
            if (dot > (best.get(row.component_id) ?? 0)) best.set(row.component_id, dot)
          }
          return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
        }),
      )
    },
  })

import { Effect, Layer, Option, Schema } from "effect"
import {
  type ComponentId,
  ComponentSnapshot,
  EnrichmentState,
  MicroUsd,
  Registry,
  type RegistryId,
  UsageDoc,
} from "@shadcn-explorer/core/domain"
import {
  type ComponentRecord,
  ComponentRepository,
  PersistenceError,
  RegistryRepository,
  UsageLedger,
} from "@shadcn-explorer/core/ports"
import { chunk, d1, placeholders } from "./d1"

const RegistryJson = Schema.parseJson(Registry)
const SnapshotJson = Schema.parseJson(ComponentSnapshot)
const DocJson = Schema.parseJson(UsageDoc)
const EnrichmentJson = Schema.parseJson(EnrichmentState)

const decodeError = (operation: string) => (cause: unknown) => new PersistenceError({ operation, cause })

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface RegistryRow {
  readonly data: string
}

const decodeRegistry = (row: RegistryRow) =>
  Schema.decodeUnknown(RegistryJson)(row.data).pipe(Effect.mapError(decodeError("decode registry")))

export const D1RegistryRepository = (db: D1Database) =>
  Layer.succeed(RegistryRepository, {
    insert: (registry) =>
      Effect.gen(function* () {
        const data = yield* Schema.encode(RegistryJson)(registry).pipe(Effect.mapError(decodeError("encode registry")))
        yield* d1("insert registry", () =>
          db
            .prepare(
              `insert into registries (id, name, namespace, index_url, owner_id, status_tag, data, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              registry.id,
              registry.name,
              registry.namespace,
              registry.locator.indexUrl,
              registry.ownerId,
              registry.status._tag,
              data,
              registry.createdAt,
              Date.now(),
            )
            .run(),
        )
      }),
    update: (registry) =>
      Effect.gen(function* () {
        const data = yield* Schema.encode(RegistryJson)(registry).pipe(Effect.mapError(decodeError("encode registry")))
        yield* d1("update registry", () =>
          db
            .prepare(`update registries set name = ?, namespace = ?, status_tag = ?, data = ?, updated_at = ? where id = ?`)
            .bind(registry.name, registry.namespace, registry.status._tag, data, Date.now(), registry.id)
            .run(),
        )
      }),
    findById: (id) =>
      d1("find registry", () => db.prepare(`select data from registries where id = ?`).bind(id).first<RegistryRow>()).pipe(
        Effect.flatMap((row) => (row ? Effect.map(decodeRegistry(row), Option.some) : Effect.succeed(Option.none()))),
      ),
    findByIndexUrl: (url) =>
      d1("find registry by url", () =>
        db.prepare(`select data from registries where index_url = ?`).bind(url).first<RegistryRow>(),
      ).pipe(Effect.flatMap((row) => (row ? Effect.map(decodeRegistry(row), Option.some) : Effect.succeed(Option.none())))),
    list: (filter) =>
      d1("list registries", () =>
        filter?.ownerId
          ? db.prepare(`select data from registries where owner_id = ? order by created_at`).bind(filter.ownerId).all<RegistryRow>()
          : db.prepare(`select data from registries order by created_at`).all<RegistryRow>(),
      ).pipe(Effect.flatMap(({ results }) => Effect.forEach(results, decodeRegistry))),
  })

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ComponentRow {
  readonly snapshot: string
  readonly doc: string | null
  readonly enrichment: string
  readonly updated_at: number
}

const COMPONENT_COLUMNS = "snapshot, doc, enrichment, updated_at"

const decodeComponent = (row: ComponentRow): Effect.Effect<ComponentRecord, PersistenceError> =>
  Effect.all({
    snapshot: Schema.decodeUnknown(SnapshotJson)(row.snapshot),
    doc: row.doc === null ? Effect.succeed(Option.none()) : Effect.map(Schema.decodeUnknown(DocJson)(row.doc), Option.some),
    enrichment: Schema.decodeUnknown(EnrichmentJson)(row.enrichment),
  }).pipe(
    Effect.map((r) => ({ ...r, updatedAt: row.updated_at })),
    Effect.mapError(decodeError("decode component")),
  )

export const D1ComponentRepository = (db: D1Database) =>
  Layer.succeed(ComponentRepository, {
    upsertSnapshots: (snapshots) =>
      Effect.gen(function* () {
        const now = Date.now()
        const initial = yield* Schema.encode(EnrichmentJson)(EnrichmentState.initial).pipe(
          Effect.mapError(decodeError("encode enrichment")),
        )
        const statements = yield* Effect.forEach(snapshots, (s) =>
          Schema.encode(SnapshotJson)(s).pipe(
            Effect.mapError(decodeError("encode snapshot")),
            Effect.map((json) =>
              db
                .prepare(
                  `insert into components (id, registry_id, name, kind, content_hash, snapshot, doc, enrichment, updated_at)
                   values (?, ?, ?, ?, ?, ?, null, ?, ?)
                   on conflict (id) do update set
                     kind = excluded.kind, content_hash = excluded.content_hash,
                     snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
                )
                .bind(s.id, s.registryId, s.name, s.kind, s.contentHash, json, initial, now),
            ),
          ),
        )
        for (const batch of chunk(statements, 50)) yield* d1("upsert components", () => db.batch(batch))
      }),
    remove: (ids) =>
      Effect.forEach(
        chunk(ids, 90),
        (part) =>
          d1("remove components", () =>
            db.prepare(`delete from components where id in (${placeholders(part.length)})`).bind(...part).run(),
          ),
        { discard: true },
      ),
    hashesByRegistry: (registryId) =>
      d1("component hashes", () =>
        db
          .prepare(`select id, content_hash from components where registry_id = ?`)
          .bind(registryId)
          .all<{ id: ComponentId; content_hash: string }>(),
      ).pipe(Effect.map(({ results }) => new Map(results.map((r) => [r.id, r.content_hash] as const)))),
    findById: (id) =>
      d1("find component", () =>
        db.prepare(`select ${COMPONENT_COLUMNS} from components where id = ?`).bind(id).first<ComponentRow>(),
      ).pipe(Effect.flatMap((row) => (row ? Effect.map(decodeComponent(row), Option.some) : Effect.succeed(Option.none())))),
    findMany: (ids) =>
      Effect.forEach(chunk(ids, 90), (part) =>
        d1("find components", () =>
          db
            .prepare(`select id, ${COMPONENT_COLUMNS} from components where id in (${placeholders(part.length)})`)
            .bind(...part)
            .all<ComponentRow & { id: ComponentId }>(),
        ),
      ).pipe(
        Effect.flatMap((pages) => Effect.forEach(pages.flatMap((p) => p.results), decodeComponent)),
        // 呼び出し側の順序 (検索順位) を保つ
        Effect.map((records) => {
          const byId = new Map(records.map((r) => [r.snapshot.id, r]))
          return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
        }),
      ),
    list: (filter) => {
      const where: Array<string> = []
      const binds: Array<unknown> = []
      if (filter.registryId) {
        where.push("registry_id = ?")
        binds.push(filter.registryId)
      }
      if (filter.kinds && filter.kinds.length > 0) {
        where.push(`kind in (${placeholders(filter.kinds.length)})`)
        binds.push(...filter.kinds)
      }
      const sql = `select ${COMPONENT_COLUMNS} from components ${where.length ? `where ${where.join(" and ")}` : ""}
                   order by registry_id, name limit ? offset ?`
      return d1("list components", () =>
        db
          .prepare(sql)
          .bind(...binds, filter.limit, filter.offset)
          .all<ComponentRow>(),
      ).pipe(Effect.flatMap(({ results }) => Effect.forEach(results, decodeComponent)))
    },
    saveDoc: (id, doc) =>
      Schema.encode(DocJson)(doc).pipe(
        Effect.mapError(decodeError("encode doc")),
        Effect.flatMap((json) =>
          d1("save doc", () =>
            db.prepare(`update components set doc = ?, updated_at = ? where id = ?`).bind(json, Date.now(), id).run(),
          ),
        ),
        Effect.asVoid,
      ),
    saveEnrichment: (id, state) =>
      Schema.encode(EnrichmentJson)(state).pipe(
        Effect.mapError(decodeError("encode enrichment")),
        Effect.flatMap((json) =>
          d1("save enrichment", () =>
            db.prepare(`update components set enrichment = ?, updated_at = ? where id = ?`).bind(json, Date.now(), id).run(),
          ),
        ),
        Effect.asVoid,
      ),
    countByRegistry: () =>
      d1("count components", () =>
        db.prepare(`select registry_id, count(*) as n from components group by registry_id`).all<{
          registry_id: RegistryId
          n: number
        }>(),
      ).pipe(Effect.map(({ results }) => new Map(results.map((r) => [r.registry_id, r.n] as const)))),
  })

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

export const D1UsageLedger = (db: D1Database) =>
  Layer.succeed(UsageLedger, {
    record: (r) =>
      d1("record usage", () =>
        db
          .prepare(`insert into usage_records (category, amount_micro_usd, subject, detail, at) values (?, ?, ?, ?, ?)`)
          .bind(r.category, r.amount, r.subject, JSON.stringify(r.detail), r.at)
          .run(),
      ).pipe(Effect.asVoid),
    spentSince: (since) =>
      d1("sum usage", () =>
        db
          .prepare(`select coalesce(sum(amount_micro_usd), 0) as total from usage_records where at >= ?`)
          .bind(since)
          .first<{ total: number }>(),
      ).pipe(Effect.map((row) => MicroUsd.make(row?.total ?? 0))),
  })

/** 管理画面向け: カテゴリ別の当月コスト */
export const usageByCategory = (db: D1Database, since: number) =>
  d1("usage by category", () =>
    db
      .prepare(
        `select category, sum(amount_micro_usd) as total, count(*) as n from usage_records where at >= ? group by category`,
      )
      .bind(since)
      .all<{ category: string; total: number; n: number }>(),
  ).pipe(Effect.map(({ results }) => results))

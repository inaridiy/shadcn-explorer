import { Effect, Layer, Option, Schema } from "effect"
import {
  type ComponentId,
  type ComponentKind,
  ComponentSnapshot,
  type DirectoryEntry,
  type ListingTag,
  type PipelineEvent,
  type StoredPipelineEvent,
  listingBadge,
  EnrichmentState,
  MicroUsd,
  Registry,
  type RegistryId,
  UsageDoc,
} from "@shadcn-explorer/core/domain"
import {
  AgentRunLedger,
  type ComponentCard,
  type ComponentRecord,
  ComponentRepository,
  DirectoryRepository,
  PipelineLog,
  PersistenceError,
  RegistryRepository,
  UsageLedger,
} from "@shadcn-explorer/core/ports"
import { chunk, type D1Client, d1, placeholders } from "./d1"

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

/** カードのバッジとギャラリーの絞り込み用 */
const listingTagOf = (registry: Registry): ListingTag => listingBadge(registry.listing)

export const D1RegistryRepository = (db: D1Client) =>
  Layer.succeed(RegistryRepository, {
    insert: (registry) =>
      Effect.gen(function* () {
        const data = yield* Schema.encode(RegistryJson)(registry).pipe(Effect.mapError(decodeError("encode registry")))
        yield* d1("insert registry", () =>
          db
            .prepare(
              `insert into registries (id, name, namespace, index_url, owner_id, status_tag, listing_tag, data, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              registry.id,
              registry.name,
              registry.namespace,
              registry.locator.indexUrl,
              registry.ownerId,
              registry.status._tag,
              listingTagOf(registry),
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
            .prepare(`update registries set name = ?, namespace = ?, status_tag = ?, listing_tag = ?, data = ?, updated_at = ? where id = ?`)
            .bind(registry.name, registry.namespace, registry.status._tag, listingTagOf(registry), data, Date.now(), registry.id)
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

/** カードに要る値だけを列と json_extract で取る (JSON 全体の転送と Schema のデコードを避ける) */
const CARD_COLUMNS = `id, registry_id, name, kind, content_hash, preview_tag,
  (select listing_tag from registries r where r.id = components.registry_id) as listing_tag,
  json_extract(snapshot, '$.title') as title,
  json_extract(snapshot, '$.description') as description,
  json_extract(doc, '$.summary') as summary,
  json_extract(enrichment, '$.doc._tag') as doc_tag,
  json_extract(enrichment, '$.index._tag') as index_tag,
  json_extract(enrichment, '$.preview.lightKey') as light_key,
  json_extract(enrichment, '$.preview.darkKey') as dark_key,
  json_extract(enrichment, '$.preview.motion.lightKey') as motion_light_key,
  json_extract(enrichment, '$.preview.motion.darkKey') as motion_dark_key`

interface CardRow {
  readonly id: ComponentId
  readonly registry_id: RegistryId
  readonly name: string
  readonly kind: ComponentKind
  readonly content_hash: string
  readonly preview_tag: string
  readonly listing_tag: ListingTag | null
  readonly title: string | null
  readonly description: string | null
  readonly summary: string | null
  readonly doc_tag: string | null
  readonly index_tag: string | null
  readonly light_key: string | null
  readonly dark_key: string | null
  readonly motion_light_key: string | null
  readonly motion_dark_key: string | null
}

const toCard = (row: CardRow): ComponentCard => {
  const captured = row.preview_tag === "Captured" && row.light_key !== null
  return {
    id: row.id,
    registryId: row.registry_id,
    name: row.name,
    kind: row.kind,
    title: row.title ?? row.name,
    description: row.description ?? "",
    summary: row.summary,
    listing: row.listing_tag ?? "Community",
    status: { doc: row.doc_tag ?? "NotGenerated", preview: row.preview_tag, index: row.index_tag ?? "NotIndexed" },
    stills: captured ? { light: row.light_key!, dark: row.dark_key } : null,
    motion: captured && row.motion_light_key !== null ? { light: row.motion_light_key, dark: row.motion_dark_key } : null,
  }
}

/** saveEnrichment と一緒に書く非正規化列 (0006_component_cards.sql) */
const cardColumns = (state: EnrichmentState) => ({
  previewTag: state.preview._tag,
  hasMotion: state.preview._tag === "Captured" && state.preview.motion !== undefined ? 1 : 0,
})

export const D1ComponentRepository = (db: D1Client) =>
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
    listCards: (filter) => {
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
      const sql = `select ${CARD_COLUMNS} from components ${where.length ? `where ${where.join(" and ")}` : ""}
                   order by registry_id, name limit ? offset ?`
      return d1("list cards", () =>
        db
          .prepare(sql)
          .bind(...binds, filter.limit, filter.offset)
          .all<CardRow>(),
      ).pipe(Effect.map(({ results }) => results.map(toCard)))
    },
    findCards: (ids) =>
      Effect.forEach(chunk(ids, 90), (part) =>
        d1("find cards", () =>
          db
            .prepare(`select ${CARD_COLUMNS} from components where id in (${placeholders(part.length)})`)
            .bind(...part)
            .all<CardRow>(),
        ),
      ).pipe(
        Effect.map((pages) => {
          const byId = new Map(pages.flatMap((p) => p.results).map((r) => [r.id, toCard(r)]))
          return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
        }),
      ),
    gallery: (filter) => {
      const where: Array<string> = ["preview_tag = 'Captured'"]
      const binds: Array<unknown> = []
      if (filter.registryIds && filter.registryIds.length > 0) {
        where.push(`registry_id in (${placeholders(filter.registryIds.length)})`)
        binds.push(...filter.registryIds)
      }
      if (filter.kinds && filter.kinds.length > 0) {
        where.push(`kind in (${placeholders(filter.kinds.length)})`)
        binds.push(...filter.kinds)
      }
      if (filter.motionOnly) where.push("has_motion = 1")
      if (filter.officialOnly) where.push("registry_id in (select id from registries where listing_tag in ('Official', 'Shadcn'))")
      if (filter.after) {
        // カーソルは "content_hash|id"。同じ中身のアイテムが別のレジストリにあっても飛ばさないよう id で順序を決める
        const [hash = "", id = ""] = filter.after.split("|")
        where.push("(content_hash > ? or (content_hash = ? and id > ?))")
        binds.push(hash, hash, id)
      }
      // 1 件多く取って次のページの有無を知る
      const sql = `select ${CARD_COLUMNS} from components where ${where.join(" and ")} order by content_hash, id limit ?`
      return d1("gallery", () =>
        db
          .prepare(sql)
          .bind(...binds, filter.limit + 1)
          .all<CardRow>(),
      ).pipe(
        Effect.map(({ results }) => {
          const page = results.slice(0, filter.limit)
          return {
            cards: page.map(toCard),
            next: results.length > filter.limit ? `${page[page.length - 1]!.content_hash}|${page[page.length - 1]!.id}` : null,
          }
        }),
      )
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
        Effect.flatMap((json) => {
          const card = cardColumns(state)
          return d1("save enrichment", () =>
            db
              .prepare(`update components set enrichment = ?, preview_tag = ?, has_motion = ?, updated_at = ? where id = ?`)
              .bind(json, card.previewTag, card.hasMotion, Date.now(), id)
              .run(),
          )
        }),
        Effect.asVoid,
      ),
    countUnfinished: () =>
      d1("count unfinished", () =>
        db
          .prepare(`select count(*) as n from components where coalesce(json_extract(enrichment, '$.index._tag'), '') != 'Indexed'`)
          .first<{ n: number }>(),
      ).pipe(Effect.map((row) => row?.n ?? 0)),
    countByRegistry: () =>
      d1("count components", () =>
        db.prepare(`select registry_id, count(*) as n from components group by registry_id`).all<{
          registry_id: RegistryId
          n: number
        }>(),
      ).pipe(Effect.map(({ results }) => new Map(results.map((r) => [r.registry_id, r.n] as const)))),
  })

// ---------------------------------------------------------------------------
// 公式ディレクトリ
// ---------------------------------------------------------------------------

interface DirectoryRow {
  readonly name: string
  readonly url: string
  readonly homepage: string | null
  readonly description: string | null
  readonly health_status: string | null
  readonly health_score: number | null
  readonly ranking_score: number | null
  readonly item_count: number | null
  readonly hidden: number
  readonly state: DirectoryEntry["state"]
  readonly registry_id: RegistryId | null
  readonly skip_reason: string | null
  readonly attempts: number
  readonly first_seen_at: number
  readonly checked_at: number
}

export const D1DirectoryRepository = (db: D1Client) =>
  Layer.succeed(DirectoryRepository, {
    list: () =>
      d1("list directory", () => db.prepare(`select * from directory_entries`).all<DirectoryRow>()).pipe(
        Effect.map(({ results }) =>
          results.map(
            (r): DirectoryEntry => ({
              name: r.name,
              url: r.url,
              homepage: r.homepage,
              description: r.description,
              healthStatus: r.health_status,
              healthScore: r.health_score,
              rankingScore: r.ranking_score,
              itemCount: r.item_count,
              hidden: r.hidden === 1,
              state: r.state,
              registryId: r.registry_id,
              skipReason: r.skip_reason,
              attempts: r.attempts,
              firstSeenAt: r.first_seen_at,
              checkedAt: r.checked_at,
            }),
          ),
        ),
      ),
    upsert: (entries) => {
      const statements = entries.map((e) =>
        db
          .prepare(
            `insert into directory_entries (name, url, homepage, description, health_status, health_score, ranking_score,
               item_count, hidden, state, registry_id, skip_reason, attempts, first_seen_at, checked_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on conflict (name) do update set
               url = excluded.url, homepage = excluded.homepage, description = excluded.description,
               health_status = excluded.health_status, health_score = excluded.health_score,
               ranking_score = excluded.ranking_score, item_count = excluded.item_count, hidden = excluded.hidden,
               state = excluded.state, registry_id = excluded.registry_id, skip_reason = excluded.skip_reason,
               attempts = excluded.attempts, checked_at = excluded.checked_at`,
          )
          .bind(
            e.name,
            e.url,
            e.homepage,
            e.description,
            e.healthStatus,
            e.healthScore,
            e.rankingScore,
            e.itemCount,
            e.hidden ? 1 : 0,
            e.state,
            e.registryId,
            e.skipReason,
            e.attempts,
            e.firstSeenAt,
            e.checkedAt,
          ),
      )
      return Effect.forEach(chunk(statements, 50), (batch) => d1("upsert directory", () => db.batch(batch)), { discard: true })
    },
  })

// ---------------------------------------------------------------------------
// 生成過程の公開ログ
// ---------------------------------------------------------------------------

interface PipelineRow {
  readonly id: number
  readonly at: number
  readonly registry_id: RegistryId
  readonly component_id: ComponentId | null
  readonly stage: PipelineEvent["stage"]
  readonly status: PipelineEvent["status"]
  readonly message: string
  readonly detail: string
}

const parseDetail = (json: string): PipelineEvent["detail"] => {
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === "object" ? (value as PipelineEvent["detail"]) : {}
  } catch {
    return {}
  }
}

export const D1PipelineLog = (db: D1Client) =>
  Layer.succeed(PipelineLog, {
    append: (e) =>
      d1("append pipeline event", () =>
        db
          .prepare(
            `insert into pipeline_events (at, registry_id, component_id, stage, status, message, detail) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(e.at, e.registryId, e.componentId, e.stage, e.status, e.message.slice(0, 500), JSON.stringify(e.detail))
          .run(),
      ).pipe(Effect.asVoid),
    list: (filter) => {
      const where: Array<string> = []
      const binds: Array<unknown> = []
      if (filter.registryId) {
        where.push("registry_id = ?")
        binds.push(filter.registryId)
      }
      if (filter.componentId) {
        where.push("component_id = ?")
        binds.push(filter.componentId)
      }
      if (filter.afterId !== undefined) {
        where.push("id > ?")
        binds.push(filter.afterId)
      }
      if (filter.since !== undefined) {
        where.push("at >= ?")
        binds.push(filter.since)
      }
      const clause = where.length ? `where ${where.join(" and ")}` : ""
      // カーソルがあれば続きを古い順に、無ければ最新の limit 件を古い順に
      const sql =
        filter.afterId !== undefined
          ? `select * from pipeline_events ${clause} order by id limit ?`
          : `select * from (select * from pipeline_events ${clause} order by id desc limit ?) order by id`
      return d1("list pipeline events", () =>
        db
          .prepare(sql)
          .bind(...binds, filter.limit)
          .all<PipelineRow>(),
      ).pipe(
        Effect.map(({ results }) =>
          results.map(
            (r): StoredPipelineEvent => ({
              id: r.id,
              at: r.at,
              registryId: r.registry_id,
              componentId: r.component_id,
              stage: r.stage,
              status: r.status,
              message: r.message,
              detail: parseDetail(r.detail),
            }),
          ),
        ),
      )
    },
    prune: (before) =>
      d1("prune pipeline events", () => db.prepare(`delete from pipeline_events where at < ?`).bind(before).run()).pipe(Effect.asVoid),
  })

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

export const D1UsageLedger = (db: D1Client) =>
  Layer.succeed(UsageLedger, {
    record: (r) =>
      d1("record usage", () =>
        db
          .prepare(
            `insert into usage_records (category, amount_micro_usd, subject, registry_id, model, detail, at) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(r.category, r.amount, r.subject, r.registryId, r.model, JSON.stringify(r.detail), r.at)
          .run(),
      ).pipe(Effect.asVoid),
    spentSince: (since, category) =>
      d1("sum usage", () =>
        (category === undefined
          ? db.prepare(`select coalesce(sum(amount_micro_usd), 0) as total from usage_records where at >= ?`).bind(since)
          : db
              .prepare(`select coalesce(sum(amount_micro_usd), 0) as total from usage_records where at >= ? and category = ?`)
              .bind(since, category)
        ).first<{ total: number }>(),
      ).pipe(Effect.map((row) => MicroUsd.make(row?.total ?? 0))),
    tokensByModelSince: (since) =>
      d1("sum tokens by model", () =>
        db
          .prepare(
            `select model, coalesce(sum(coalesce(json_extract(detail, '$.inputTokens'), 0) + coalesce(json_extract(detail, '$.outputTokens'), 0)), 0) as tokens
             from usage_records where at >= ? and model is not null group by model`,
          )
          .bind(since)
          .all<{ model: string; tokens: number }>(),
      ).pipe(Effect.map(({ results }) => new Map(results.map((r) => [r.model, r.tokens] as const)))),
  })

// ---------------------------------------------------------------------------
// Preview agent runs
// ---------------------------------------------------------------------------

export const D1AgentRunLedger = (db: D1Client) =>
  Layer.succeed(AgentRunLedger, {
    record: (run) =>
      d1("record agent run", () =>
        db
          .prepare(
            `insert into preview_agent_runs (component_id, registry_id, build_version, outcome, workarounds, detail, at) values (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(run.componentId, run.registryId, run.buildVersion, run.outcome, JSON.stringify(run.workarounds), run.detail, run.at)
          .run(),
      ).pipe(Effect.asVoid),
    stats: (registryId, buildVersion) =>
      d1("agent run stats", () =>
        db
          .prepare(
            `select count(*) as runs, coalesce(sum(outcome = 'succeeded'), 0) as succeeded from preview_agent_runs where registry_id = ? and build_version = ?`,
          )
          .bind(registryId, buildVersion)
          .first<{ runs: number; succeeded: number }>(),
      ).pipe(Effect.map((row) => ({ runs: row?.runs ?? 0, succeeded: row?.succeeded ?? 0 }))),
  })

/** 管理画面向け: カテゴリ別の当月コスト */
export const usageByCategory = (db: D1Client, since: number) =>
  d1("usage by category", () =>
    db
      .prepare(
        `select category, sum(amount_micro_usd) as total, count(*) as n from usage_records where at >= ? group by category`,
      )
      .bind(since)
      .all<{ category: string; total: number; n: number }>(),
  ).pipe(Effect.map(({ results }) => results))

/** 管理画面向け: レジストリ別の当月コスト (上位) */
export const usageByRegistry = (db: D1Client, since: number, limit = 10) =>
  d1("usage by registry", () =>
    db
      .prepare(
        `select registry_id, sum(amount_micro_usd) as total, count(*) as n from usage_records
         where at >= ? and registry_id is not null group by registry_id order by total desc limit ?`,
      )
      .bind(since, limit)
      .all<{ registry_id: string; total: number; n: number }>(),
  ).pipe(Effect.map(({ results }) => results))

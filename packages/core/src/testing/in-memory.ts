/**
 * ポートのインメモリ実装。
 * - 単体テストで Layer として差し込む
 * - API キー無しのローカル開発 (`EXPLORER_BACKEND=memory`) でもそのまま使う
 */
import { type Context, Effect, Layer, Option } from "effect"
import {
  type ComponentId,
  type ComponentSnapshot,
  EnrichmentState,
  MicroUsd,
  type Registry,
  type RegistryId,
  UsageDoc,
  type UsageRecord,
  usd,
} from "../domain/index.js"
import {
  AgentError,
  BlobStore,
  CodingAgent,
  type ComponentRecord,
  ComponentRepository,
  Embedder,
  ExplorerConfig,
  type IndexFilters,
  JobScheduler,
  PreviewRenderer,
  RegistryFetchError,
  RegistryHttp,
  RegistryRepository,
  TextSearchIndex,
  type TextDocument,
  UsageLedger,
  type Vector,
  VisualIndex,
  type VisualVector,
} from "../ports/index.js"
import { Bm25Index, tokenize } from "./bm25.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const testConfig: Context.Tag.Service<ExplorerConfig> = {
  prices: {
    agentRunEstimate: usd(0.02),
    browserPerSecond: usd(0.09 / 3600),
    browserSecondsPerPreview: 6,
    textEmbedding: usd(0.0002),
    imageEmbedding: usd(0.00012),
  },
  budget: { monthlyLimit: usd(50), softLimitRatio: 0.8, maxItemsPerRegistry: 500 },
  enrichment: { maxAttempts: 3, capturePreviews: true },
  directoryUrl: "https://ui.shadcn.com/r/registries.json",
  syncTimeoutMs: 30 * 60 * 1000,
}

export const ExplorerConfigTest = (overrides: Partial<Context.Tag.Service<ExplorerConfig>> = {}) =>
  Layer.succeed(ExplorerConfig, { ...testConfig, ...overrides })

// ---------------------------------------------------------------------------
// Registry HTTP (フィクスチャから返す)
// ---------------------------------------------------------------------------

export const RegistryHttpFixture = (fixtures: Record<string, unknown>, calls: Array<string> = []) =>
  Layer.succeed(RegistryHttp, {
    getJson: (url) =>
      Effect.suspend(() => {
        calls.push(url)
        return url in fixtures
          ? Effect.succeed(structuredClone(fixtures[url]))
          : Effect.fail(new RegistryFetchError({ url, reason: "not found", status: 404 }))
      }),
  })

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export const InMemoryRegistryRepository = Layer.sync(RegistryRepository, () => {
  const store = new Map<RegistryId, Registry>()
  return {
    insert: (r) => Effect.sync(() => void store.set(r.id, r)),
    update: (r) => Effect.sync(() => void store.set(r.id, r)),
    findById: (id) => Effect.sync(() => Option.fromNullable(store.get(id))),
    findByIndexUrl: (url) =>
      Effect.sync(() => Option.fromNullable([...store.values()].find((r) => r.locator.indexUrl === url))),
    list: (filter) =>
      Effect.sync(() =>
        [...store.values()]
          .filter((r) => (filter?.ownerId ? r.ownerId === filter.ownerId : true))
          .sort((a, b) => a.createdAt - b.createdAt),
      ),
  }
})

export const InMemoryComponentRepository = Layer.sync(ComponentRepository, () => {
  const store = new Map<ComponentId, ComponentRecord>()
  let tick = 0
  const put = (r: ComponentRecord) => void store.set(r.snapshot.id, { ...r, updatedAt: ++tick })
  return {
    upsertSnapshots: (snapshots: ReadonlyArray<ComponentSnapshot>) =>
      Effect.sync(() => {
        for (const snapshot of snapshots) {
          const prev = store.get(snapshot.id)
          put(
            prev
              ? { ...prev, snapshot }
              : { snapshot, doc: Option.none(), enrichment: EnrichmentState.initial, updatedAt: 0 },
          )
        }
      }),
    remove: (ids) => Effect.sync(() => ids.forEach((id) => store.delete(id))),
    hashesByRegistry: (registryId) =>
      Effect.sync(
        () =>
          new Map(
            [...store.values()]
              .filter((r) => r.snapshot.registryId === registryId)
              .map((r) => [r.snapshot.id, r.snapshot.contentHash] as const),
          ),
      ),
    findById: (id) => Effect.sync(() => Option.fromNullable(store.get(id))),
    findMany: (ids) => Effect.sync(() => ids.flatMap((id) => (store.has(id) ? [store.get(id)!] : []))),
    list: (filter) =>
      Effect.sync(() =>
        [...store.values()]
          .filter((r) => (filter.registryId ? r.snapshot.registryId === filter.registryId : true))
          .filter((r) => (filter.kinds ? filter.kinds.includes(r.snapshot.kind) : true))
          .sort((a, b) => a.snapshot.id.localeCompare(b.snapshot.id))
          .slice(filter.offset, filter.offset + filter.limit),
      ),
    saveDoc: (id, doc) =>
      Effect.sync(() => {
        const r = store.get(id)
        if (r) put({ ...r, doc: Option.some(doc) })
      }),
    saveEnrichment: (id, enrichment) =>
      Effect.sync(() => {
        const r = store.get(id)
        if (r) put({ ...r, enrichment })
      }),
    countByRegistry: () =>
      Effect.sync(() => {
        const counts = new Map<RegistryId, number>()
        for (const r of store.values()) counts.set(r.snapshot.registryId, (counts.get(r.snapshot.registryId) ?? 0) + 1)
        return counts
      }),
  }
})

export const InMemoryBlobStore = Layer.sync(BlobStore, () => {
  const store = new Map<string, Uint8Array>()
  return {
    put: (key, body) =>
      Effect.sync(() => void store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body)),
    get: (key) => Effect.sync(() => Option.fromNullable(store.get(key))),
    remove: (keys) => Effect.sync(() => keys.forEach((k) => store.delete(k))),
  }
})

// ---------------------------------------------------------------------------
// AI / Rendering fakes (決定的)
// ---------------------------------------------------------------------------

export const fakeUsageDoc = (snapshot: ComponentSnapshot): UsageDoc =>
  new UsageDoc({
    summary: `${snapshot.title} component. ${snapshot.description}`.trim(),
    visualDescription: `A ${snapshot.kind} named ${snapshot.title}`,
    whenToUse: [`When you need a ${snapshot.title.toLowerCase()}`],
    usage: `import { ${snapshot.title.replace(/\s/g, "")} } from "@/components/ui/${snapshot.name}"`,
    examples: [{ title: "Default", description: "Basic usage", code: `<${snapshot.title.replace(/\s/g, "")} />` }],
    props: [],
    accessibility: [],
    agentPrompt: `Use the ${snapshot.name} component from ${snapshot.registryId}.`,
    keywords: [snapshot.name, snapshot.kind, ...snapshot.categories],
  })

export const FakeCodingAgent = (options: { readonly failFor?: ReadonlyArray<string> } = {}) =>
  Layer.succeed(CodingAgent, {
    presetName: "fake",
    generate: ({ snapshot }) =>
      options.failFor?.includes(snapshot.name)
        ? Effect.fail(new AgentError({ reason: `agent failed for ${snapshot.name}`, retryable: false }))
        : Effect.succeed({
            doc: fakeUsageDoc(snapshot),
            previewHtml: Option.some(
              `<!doctype html><html><body><div id="preview">${snapshot.title} ${snapshot.description}</div></body></html>`,
            ),
            usage: { inputTokens: 1000, outputTokens: 500, durationMs: 1000 },
          }),
  })

/** 「PNG」の中身として HTML のテキストを入れる。FakeEmbedder がそれを読んで埋め込むので画像検索も擬似的に動く */
export const FakePreviewRenderer = Layer.succeed(PreviewRenderer, {
  capture: (html, scheme) =>
    Effect.succeed({
      png: new TextEncoder().encode(`${scheme}:${html.replace(/<[^>]+>/g, " ")}`),
      durationMs: 3000,
    }),
})

const DIMS = 256

/** Hashing trick による決定的な埋め込み。意味は捉えないが語の重なりでコサイン類似度が効く */
export const hashEmbed = (text: string): Vector => {
  const v = new Array<number>(DIMS).fill(0)
  for (const token of tokenize(text)) {
    let h = 2166136261
    for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619)
    v[Math.abs(h) % DIMS]! += 1
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

export const FakeEmbedder = Layer.succeed(Embedder, {
  model: "fake-hash-embedding",
  embedQuery: (text) => Effect.succeed(hashEmbed(text)),
  embedDocument: (title, text) => Effect.succeed(hashEmbed(`${title} ${text}`)),
  embedImage: (png) => Effect.succeed(hashEmbed(new TextDecoder().decode(png))),
})

// ---------------------------------------------------------------------------
// Search indexes
// ---------------------------------------------------------------------------

const matchesFilters = (
  entry: { readonly registryId: RegistryId; readonly kind: string },
  filters: IndexFilters,
): boolean =>
  (!filters.registryIds || filters.registryIds.includes(entry.registryId)) &&
  (!filters.kinds || (filters.kinds as ReadonlyArray<string>).includes(entry.kind))

const cosine = (a: Vector, b: Vector): number => {
  let dot = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!
  return dot
}

/** キーワード = 本物の BM25、ベクトル = hashEmbed のコサイン類似度 */
export const InMemoryTextSearchIndex = Layer.sync(TextSearchIndex, () => {
  const docs = new Map<ComponentId, TextDocument>()
  const bm25 = new Bm25Index()
  return {
    upsert: (doc) =>
      Effect.sync(() => {
        docs.set(doc.componentId, doc)
        bm25.upsert(doc.componentId, doc.markdown)
      }),
    remove: (ids) =>
      Effect.sync(() =>
        ids.forEach((id) => {
          docs.delete(id)
          bm25.remove(id)
        }),
      ),
    search: (text, retrieval, filters, limit) =>
      Effect.sync(() => {
        const allowed = (id: string) => {
          const d = docs.get(id as ComponentId)
          return d !== undefined && matchesFilters(d, filters)
        }
        if (retrieval === "keyword") {
          return bm25
            .search(text)
            .filter((h) => allowed(h.id))
            .slice(0, limit)
            .map((h) => h.id as ComponentId)
        }
        const q = hashEmbed(text)
        return [...docs.values()]
          .filter((d) => matchesFilters(d, filters))
          .map((d) => ({ id: d.componentId, score: cosine(q, hashEmbed(d.markdown)) }))
          .filter((h) => h.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((h) => h.id)
      }),
  }
})

export const InMemoryVisualIndex = Layer.sync(VisualIndex, () => {
  const vectors = new Map<string, VisualVector>()
  return {
    upsert: (vs) => Effect.sync(() => vs.forEach((v) => vectors.set(`${v.componentId}#${v.modality}`, v))),
    remove: (ids) =>
      Effect.sync(() => {
        for (const [key, v] of vectors) if (ids.includes(v.componentId)) vectors.delete(key)
      }),
    query: (vector, filters, limit) =>
      Effect.sync(() => {
        const best = new Map<ComponentId, number>()
        for (const v of vectors.values()) {
          if (!matchesFilters(v, filters)) continue
          const s = cosine(vector, v.values)
          if (s > (best.get(v.componentId) ?? 0)) best.set(v.componentId, s)
        }
        return [...best.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([id]) => id)
      }),
  }
})

// ---------------------------------------------------------------------------
// Jobs & usage
// ---------------------------------------------------------------------------

export interface ScheduledJobs {
  readonly syncs: Array<RegistryId>
  readonly enrichments: Array<ComponentId>
}

export const RecordingJobScheduler = (jobs: ScheduledJobs = { syncs: [], enrichments: [] }) =>
  Layer.succeed(JobScheduler, {
    scheduleSync: (id) => Effect.sync(() => void jobs.syncs.push(id)),
    scheduleEnrichment: (ids) => Effect.sync(() => void jobs.enrichments.push(...ids)),
  })

export const InMemoryUsageLedger = (records: Array<UsageRecord> = []) =>
  Layer.succeed(UsageLedger, {
    record: (r) => Effect.sync(() => void records.push(r)),
    spentSince: (since) =>
      Effect.sync(() => MicroUsd.make(records.filter((r) => r.at >= since).reduce((s, r) => s + r.amount, 0))),
  })

// ---------------------------------------------------------------------------
// All-in-one
// ---------------------------------------------------------------------------

export interface InMemoryOptions {
  readonly fixtures?: Record<string, unknown>
  readonly httpCalls?: Array<string>
  readonly jobs?: ScheduledJobs
  readonly usage?: Array<UsageRecord>
  readonly config?: Partial<Context.Tag.Service<ExplorerConfig>>
  readonly agentFailFor?: ReadonlyArray<string>
  /** 本物の RegistryHttp を使う場合に差し替える */
  readonly http?: Layer.Layer<RegistryHttp>
}

export const makeInMemoryLayer = (options: InMemoryOptions = {}) =>
  Layer.mergeAll(
    options.http ?? RegistryHttpFixture(options.fixtures ?? {}, options.httpCalls),
    InMemoryRegistryRepository,
    InMemoryComponentRepository,
    InMemoryBlobStore,
    FakeCodingAgent(options.agentFailFor ? { failFor: options.agentFailFor } : {}),
    FakePreviewRenderer,
    FakeEmbedder,
    InMemoryTextSearchIndex,
    InMemoryVisualIndex,
    RecordingJobScheduler(options.jobs),
    InMemoryUsageLedger(options.usage),
    ExplorerConfigTest(options.config),
  )

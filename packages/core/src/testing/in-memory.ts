/**
 * ポートのインメモリ実装。
 * - 単体テストで Layer として差し込む
 * - API キー無しのローカル開発 (`EXPLORER_BACKEND=memory`) でもそのまま使う
 */
import { type Context, Effect, Layer, Option } from "effect"
import {
  type ComponentId,
  type ComponentSnapshot,
  type DirectoryEntry,
  type StoredPipelineEvent,
  BUILD_VERSION,
  CAPTURE_VERSION,
  EnrichmentState,
  itemImportPaths,
  MicroUsd,
  type Registry,
  type RegistryId,
  type ThemeTokens,
  UsageDoc,
  type UsageRecord,
  usd,
} from "../domain/index.js"
import {
  AgentError,
  type AgentRun,
  AgentRunLedger,
  BlobStore,
  DocsError,
  DocsReader,
  DocWriter,
  type ComponentRecord,
  toComponentCard,
  ComponentRepository,
  DirectoryRepository,
  PipelineLog,
  Embedder,
  ExplorerConfig,
  type IndexFilters,
  JobScheduler,
  DemoWriter,
  PreviewAgent,
  PreviewCompiler,
  type PreviewCompileResult,
  PreviewRenderer,
  RegistryFetchError,
  RegistryHttp,
  RegistryRepository,
  TextSearchIndex,
  type TextDocument,
  ThemeAgent,
  type ThemeAgentInput,
  type ThemeAgentPoll,
  UsageLedger,
  type Vector,
  VectorIndex,
  type ComponentVector,
} from "../ports/index.js"
import { Bm25Index, tokenize } from "./bm25.js"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GPT_6_LUNA = { inputPerMTok: 0.1, cachedInputPerMTok: 0.01, outputPerMTok: 0.5 }

export const testConfig: Context.Tag.Service<ExplorerConfig> = {
  prices: {
    docModel: GPT_6_LUNA,
    docTokensEstimate: { inputTokens: 12_000, outputTokens: 3_000 },
    previewModel: GPT_6_LUNA,
    previewTokensEstimate: { inputTokens: 20_000, cachedInputTokens: 0, outputTokens: 3_000 },
    sandboxPerSecond: usd(0.00002),
    sandboxSecondsPerPreview: 30,
    browserPerSecond: usd(0.09 / 3600),
    browserSecondsPerPreview: 6,
    textEmbedding: usd(0.0002),
    imageEmbedding: usd(0.00012),
  },
  budget: { monthlyLimit: usd(50), softLimitRatio: 0.8, maxItemsPerRegistry: 500, maxItemsPerUserPerMonth: 1000 },
  enrichment: { maxAttempts: 3, capturePreviews: true, buildVersion: BUILD_VERSION, captureVersion: CAPTURE_VERSION },
  directoryUrl: "https://ui.shadcn.com/r/registries.json",
  syncTimeoutMs: 30 * 60 * 1000,
  // 既定は無料枠なし (= 従来どおり 1 モデルを有料で使う)。無料枠のテストは quotas を渡す
  llm: {
    doc: ["gpt-6-luna"],
    demo: ["gpt-6-luna"],
    repair: ["gpt-6-luna"],
    quotas: [],
    useRatio: 0.9,
    headroomTokens: 20_000,
    overflow: { _tag: "Pause" },
    rates: { "gpt-6-luna": GPT_6_LUNA },
  },
  lifecycle: { resyncIntervalMs: 7 * 24 * 3600 * 1000, resyncPerRun: 50, directoryIntake: true, intakePerRun: 10, maxBacklog: 1000 },
  // テーマのエージェントを回すと同期のたびにプレビューが保留されるので、既定では無効 (テーマのテストだけ有効にする)
  themeAgent: false,
  previewBuild: {
    maxRepairs: 2,
    agent: {
      maxPerRegistry: 30,
      maxRatio: 0.25,
      monthlyBudget: usd(10),
      breakerMinRuns: 10,
      breakerMinSuccessRate: 0.5,
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    },
  },
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
    listCards: (filter) =>
      Effect.sync(() =>
        [...store.values()]
          .filter((r) => (filter.registryId ? r.snapshot.registryId === filter.registryId : true))
          .filter((r) => (filter.kinds ? filter.kinds.includes(r.snapshot.kind) : true))
          .sort((a, b) => a.snapshot.name.localeCompare(b.snapshot.name))
          .slice(filter.offset, filter.offset + filter.limit)
          .map((r) => toComponentCard(r)),
      ),
    findCards: (ids) => Effect.sync(() => ids.flatMap((id) => (store.has(id) ? [toComponentCard(store.get(id)!)] : []))),
    gallery: (filter) =>
      Effect.sync(() => {
        const matching = [...store.values()]
          .filter((r) => r.enrichment.preview._tag === "Captured")
          .filter((r) => (filter.registryIds ? filter.registryIds.includes(r.snapshot.registryId) : true))
          .filter((r) => (filter.kinds ? filter.kinds.includes(r.snapshot.kind) : true))
          .filter((r) => !filter.motionOnly || (r.enrichment.preview._tag === "Captured" && r.enrichment.preview.motion !== undefined))
          .sort((a, b) => a.snapshot.contentHash.localeCompare(b.snapshot.contentHash) || a.snapshot.id.localeCompare(b.snapshot.id))
          .filter((r) => {
            if (!filter.after) return true
            const [hash = "", id = ""] = filter.after.split("|")
            return r.snapshot.contentHash > hash || (r.snapshot.contentHash === hash && r.snapshot.id > id)
          })
        const page = matching.slice(0, filter.limit)
        const last = page[page.length - 1]
        return {
          cards: page.map((r) => toComponentCard(r)),
          next: matching.length > filter.limit && last ? `${last.snapshot.contentHash}|${last.snapshot.id}` : null,
        }
      }),
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
    countUnfinished: () => Effect.sync(() => [...store.values()].filter((r) => r.enrichment.index._tag !== "Indexed").length),
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
    keywords: [snapshot.name, snapshot.kind, ...snapshot.categories],
  })

export const FakeDocWriter = (options: { readonly failFor?: ReadonlyArray<string> } = {}) =>
  Layer.succeed(DocWriter, {
    model: "fake",
    write: ({ snapshot }) =>
      options.failFor?.includes(snapshot.name)
        ? Effect.fail(new AgentError({ reason: `doc writer failed for ${snapshot.name}`, retryable: false }))
        : Effect.succeed({
            doc: fakeUsageDoc(snapshot),
            usage: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 2_000, durationMs: 1000 },
          }),
  })

/**
 * フェイクのデモライター。
 * - failFor: 呼び出し自体が失敗する
 * - lintFailFor: 初回だけ lint に掛かるデモ (見出し付き) を返し、repair で直す
 * - calls: write (新しいデモを書いた) の呼び出し記録
 * トークンは消費していない扱い (ローカルの台帳・予算を汚さない)
 */
export const FakeDemoWriter = (
  options: {
    readonly failFor?: ReadonlyArray<string>
    readonly lintFailFor?: ReadonlyArray<string>
    readonly calls?: Array<string>
  } = {},
) => {
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0 }
  const demo = (snapshot: ComponentSnapshot, itemJson: unknown, heading: boolean) =>
    [
      ...itemImportPaths(itemJson).slice(0, 1).map((p) => `import * as Item from "${p}"\n`),
      `export default function Demo() {`,
      `  return (`,
      `    <div className="w-full max-w-sm">`,
      heading ? `      <h1>${snapshot.title}</h1>` : `      <p>${snapshot.title}</p>`,
      `    </div>`,
      `  )`,
      `}`,
    ].join("\n")
  return Layer.succeed(DemoWriter, {
    model: "fake",
    write: ({ snapshot, itemJson }) =>
      Effect.sync(() => options.calls?.push(snapshot.name)).pipe(
        Effect.zipRight(writeDemo(snapshot, itemJson)),
      ),
    repair: ({ snapshot, itemJson }) => Effect.succeed({ code: demo(snapshot, itemJson, false), usage }),
  })
  function writeDemo(snapshot: ComponentSnapshot, itemJson: unknown) {
    return options.failFor?.includes(snapshot.name)
        ? Effect.fail(new AgentError({ reason: `demo writer failed for ${snapshot.name}`, retryable: false }))
        : Effect.succeed({ code: demo(snapshot, itemJson, options.lintFailFor?.includes(snapshot.name) ?? false), usage })
  }
}

/**
 * フェイクのコンパイラ。完成する HTML にはタイトルと説明を入れるので、FakeEmbedder 経由の画像検索も擬似的に効く。
 * - installFailFor: アイテムが入らない (registry 起因。デモを直しても無駄)
 * - buildFailFor:   デモ起因のビルドが常に失敗する (修正回数を使い切る)
 * - registryBrokenFor: レジストリ側のビルドエラー。manifest (エージェントの手順) があれば通る
 * - diagnosticsOnceFor: 初回だけ型エラー付きでビルドできる
 * - calls: コンパイルの呼び出し記録 (テスト用)
 */
export const FakePreviewCompiler = (
  options: {
    readonly installFailFor?: ReadonlyArray<string>
    readonly buildFailFor?: ReadonlyArray<string>
    readonly registryBrokenFor?: ReadonlyArray<string>
    readonly diagnosticsOnceFor?: ReadonlyArray<string>
    readonly calls?: Array<string>
  } = {},
) =>
  Layer.sync(PreviewCompiler, () => {
    const seen = new Set<string>()
    return {
      name: "fake",
      compile: ({ snapshot, demo, manifest }) =>
        Effect.sync((): PreviewCompileResult => {
          options.calls?.push(snapshot.name)
          const rejected = (stage: "install" | "build", cause: "registry" | "demo", error: string): PreviewCompileResult => ({
            _tag: "Rejected",
            stage,
            cause,
            errors: [error],
            workarounds: [],
            durationMs: 0,
          })
          if (options.installFailFor?.includes(snapshot.name)) return rejected("install", "registry", "item not found")
          if (options.buildFailFor?.includes(snapshot.name)) return rejected("build", "demo", "src/demo.tsx: syntax error")
          if (options.registryBrokenFor?.includes(snapshot.name) && manifest === null) {
            return rejected("build", "registry", "src/components/broken.tsx: missing export")
          }
          const first = !seen.has(snapshot.name)
          seen.add(snapshot.name)
          return {
            _tag: "Compiled",
            html: `<!doctype html><html><body><div id="preview" data-layout="${demo.layout}">${snapshot.title} ${snapshot.description}</div></body></html>`,
            diagnostics: first && options.diagnosticsOnceFor?.includes(snapshot.name) ? ["src/demo.tsx(1,1): error TS2322"] : [],
            workarounds: manifest ? manifest.actions.map((a) => a.type) : [],
            durationMs: 0,
          }
        }),
    }
  })

/** フェイクの撮影の呼び出し記録 (配色と、注入したトークン) */
export interface RecordedCapture {
  readonly schemes: ReadonlyArray<string>
  readonly tokens: ThemeTokens | null
}

/**
 * 埋め込み用の「JPEG」の中身として HTML のテキストを入れる。FakeEmbedder がそれを読んで埋め込むので画像検索も擬似的に動く。
 * - animatedFor: 名前 (HTML に含まれる文字列) が一致すると動く部品としてコマ列を返す
 * - runtimeErrorFor: 描画時に例外を出す
 */
export const FakePreviewRendererWith = (
  options: {
    readonly animatedFor?: ReadonlyArray<string>
    readonly runtimeErrorFor?: ReadonlyArray<string>
    readonly captures?: Array<RecordedCapture>
  } = {},
) =>
  Layer.succeed(PreviewRenderer, {
    capture: (html, schemes, _layout, captureOptions) =>
      Effect.sync(() => {
        options.captures?.push({ schemes, tokens: captureOptions?.tokens ?? null })
      }).pipe(Effect.as({
        runtimeErrors: options.runtimeErrorFor?.some((n) => html.includes(n)) ? ["Error: boom"] : [],
        shots: schemes.map((scheme) => ({
          scheme,
          webp: new TextEncoder().encode(`still:${scheme}`),
          jpeg: new TextEncoder().encode(`${scheme}:${html.replace(/<[^>]+>/g, " ")}`),
        })),
        motion: options.animatedFor?.some((n) => html.includes(n))
          ? schemes.map((scheme) => ({ scheme, webp: new TextEncoder().encode(`webp:${scheme}`), durationMs: 3000 }))
          : null,
        durationMs: 3000 * schemes.length,
      })),
  })
export const FakePreviewRenderer = FakePreviewRendererWith()

/**
 * フェイクの Coding Agent。`pollsUntilDone` 回目の poll で完了する。
 * - recipe: 返すビルド手順 (既定は compat ファイル 1 つ)。デモはアイテムを import する最小のもの
 * - gaveUpFor: 直せないと答える
 */
export const FakePreviewAgent = (
  options: {
    readonly pollsUntilDone?: number
    readonly gaveUpFor?: ReadonlyArray<string>
    readonly manifest?: unknown
    readonly started?: Array<string>
  } = {},
) =>
  Layer.sync(PreviewAgent, () => {
    const jobs = new Map<string, { polls: number; name: string; itemJson: unknown }>()
    let seq = 0
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0 }
    return {
      name: "fake",
      start: ({ snapshot, itemJson }) =>
        Effect.sync(() => {
          options.started?.push(snapshot.name)
          const id = `agent-${++seq}`
          jobs.set(id, { polls: 0, name: snapshot.name, itemJson })
          return { id, startedAt: 0 }
        }),
      poll: (job) =>
        Effect.sync(() => {
          const j = jobs.get(job.id)!
          j.polls++
          if (j.polls < (options.pollsUntilDone ?? 1)) return { _tag: "Running" as const }
          if (options.gaveUpFor?.includes(j.name)) {
            return { _tag: "Done" as const, result: { _tag: "GaveUp" as const, reason: "cannot fix" }, usage }
          }
          const imports = itemImportPaths(j.itemJson).slice(0, 1)
          const demo = [...imports.map((p) => `import * as Item from "${p}"`), "export default function Demo() { return <p>ok</p> }"].join("\n")
          const manifest = options.manifest ?? {
            actions: [{ type: "writeFile", path: "stub.css", content: "", reason: "missing css" }],
          }
          return { _tag: "Done" as const, result: { _tag: "Recipe" as const, demo, manifest }, usage }
        }),
      cancel: (job) => Effect.sync(() => void jobs.delete(job.id)),
    }
  })

/**
 * フェイクのテーマ用エージェント。`pollsUntilDone` 回目の poll で `output` (theme.json) を返す。
 * output が null なら手順が見つからなかったと答える。started に入力を記録する。
 */
export const FakeThemeAgent = (
  options: {
    readonly pollsUntilDone?: number
    readonly output?: unknown
    readonly started?: Array<ThemeAgentInput>
    /** 片付けた (cancel した) セッション */
    readonly cancelled?: Array<string>
  } = {},
) =>
  Layer.sync(ThemeAgent, () => {
    const polls = new Map<string, number>()
    let seq = 0
    const usage = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, durationMs: 0 }
    return {
      name: "fake",
      start: (input) =>
        Effect.sync(() => {
          options.started?.push(input)
          const id = `theme-${++seq}`
          polls.set(id, 0)
          return { id, startedAt: 0 }
        }),
      poll: (job) =>
        Effect.sync((): ThemeAgentPoll => {
          const n = (polls.get(job.id) ?? 0) + 1
          polls.set(job.id, n)
          if (n < (options.pollsUntilDone ?? 1)) return { _tag: "Running" }
          if (options.output === null || options.output === undefined) {
            return { _tag: "Done", result: { _tag: "GaveUp", reason: "no installation instructions" }, usage }
          }
          return { _tag: "Done", result: { _tag: "Proposal", raw: options.output }, usage }
        }),
      cancel: (job) =>
        Effect.sync(() => {
          options.cancelled?.push(job.id)
          polls.delete(job.id)
        }),
    }
  })

/** フィクスチャのページを返すドキュメントの読み取り ({ url: { markdown, links } }) */
export const FakeDocsReader = (pages: Record<string, { readonly markdown: string; readonly links?: ReadonlyArray<string> }> = {}) =>
  Layer.succeed(DocsReader, {
    name: "fake",
    links: (url) =>
      url in pages ? Effect.succeed(pages[url]!.links ?? []) : Effect.fail(new DocsError({ url, reason: "not found" })),
    read: (url) =>
      url in pages ? Effect.succeed({ url, markdown: pages[url]!.markdown }) : Effect.fail(new DocsError({ url, reason: "not found" })),
  })

export const InMemoryAgentRunLedger = (runs: Array<AgentRun> = []) =>
  Layer.succeed(AgentRunLedger, {
    record: (run) => Effect.sync(() => void runs.push(run)),
    stats: (registryId, buildVersion) =>
      Effect.sync(() => {
        const mine = runs.filter((r) => r.registryId === registryId && r.buildVersion === buildVersion)
        return { runs: mine.length, succeeded: mine.filter((r) => r.outcome === "succeeded").length }
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
  embedImage: (image) => Effect.succeed(hashEmbed(new TextDecoder().decode(image))),
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

/** 本物の BM25 */
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
    search: (text, filters, limit) =>
      Effect.sync(() => {
        const allowed = (id: string) => {
          const d = docs.get(id as ComponentId)
          return d !== undefined && matchesFilters(d, filters)
        }
        return bm25
          .search(text)
          .filter((h) => allowed(h.id))
          .slice(0, limit)
          .map((h) => h.id as ComponentId)
      }),
  }
})

export const InMemoryVectorIndex = Layer.sync(VectorIndex, () => {
  const vectors = new Map<string, ComponentVector>()
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
          if (!matchesFilters(v, filters) || !filters.modalities.includes(v.modality)) continue
          if (filters.excludeRegistryIds?.includes(v.registryId)) continue
          const s = cosine(vector, v.values)
          if (s > (best.get(v.componentId) ?? 0)) best.set(v.componentId, s)
        }
        return [...best.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, limit)
          .map(([id]) => id)
      }),
    vectorsOf: (componentId, modalities) =>
      Effect.sync(() =>
        modalities.flatMap((m) => {
          const v = vectors.get(`${componentId}#${m}`)
          return v ? [v] : []
        }),
      ),
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
    pendingEnrichments: () => Effect.sync(() => jobs.enrichments.length),
  })

export const InMemoryPipelineLog = (events: Array<StoredPipelineEvent> = []) =>
  Layer.succeed(PipelineLog, {
    append: (event) => Effect.sync(() => void events.push({ ...event, id: events.length + 1 })),
    list: (filter) =>
      Effect.sync(() => {
        const matching = events.filter(
          (e) =>
            (filter.registryId ? e.registryId === filter.registryId : true) &&
            (filter.componentId ? e.componentId === filter.componentId : true) &&
            (filter.afterId !== undefined ? e.id > filter.afterId : true) &&
            (filter.since !== undefined ? e.at >= filter.since : true),
        )
        return filter.afterId !== undefined ? matching.slice(0, filter.limit) : matching.slice(-filter.limit)
      }),
    prune: (before) =>
      Effect.sync(() => {
        const kept = events.filter((e) => e.at >= before)
        events.splice(0, events.length, ...kept)
      }),
  })

export const InMemoryDirectoryRepository = Layer.sync(DirectoryRepository, () => {
  const store = new Map<string, DirectoryEntry>()
  return {
    list: () => Effect.sync(() => [...store.values()]),
    upsert: (entries) => Effect.sync(() => entries.forEach((e) => store.set(e.name, e))),
  }
})

export const InMemoryUsageLedger = (records: Array<UsageRecord> = []) =>
  Layer.succeed(UsageLedger, {
    record: (r) => Effect.sync(() => void records.push(r)),
    spentSince: (since, category) =>
      Effect.sync(() =>
        MicroUsd.make(
          records.filter((r) => r.at >= since && (category === undefined || r.category === category)).reduce((s, r) => s + r.amount, 0),
        ),
      ),
    tokensByModelSince: (since) =>
      Effect.sync(() => {
        const out = new Map<string, number>()
        for (const r of records) {
          if (r.at < since || r.model === null) continue
          out.set(r.model, (out.get(r.model) ?? 0) + (r.detail.inputTokens ?? 0) + (r.detail.outputTokens ?? 0))
        }
        return out
      }),
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
  /** デモのビルドが常に失敗するアイテム */
  readonly previewFailFor?: ReadonlyArray<string>
  readonly demoWriter?: Layer.Layer<DemoWriter>
  readonly compiler?: Layer.Layer<PreviewCompiler>
  readonly renderer?: Layer.Layer<PreviewRenderer>
  readonly agent?: Layer.Layer<PreviewAgent>
  readonly themeAgent?: Layer.Layer<ThemeAgent>
  readonly docs?: Layer.Layer<DocsReader>
  readonly agentRuns?: Array<AgentRun>
  /** 生成過程の公開ログ (テストで中身を見る) */
  readonly events?: Array<StoredPipelineEvent>
  /** 本物の RegistryHttp を使う場合に差し替える */
  readonly http?: Layer.Layer<RegistryHttp>
}

export const makeInMemoryLayer = (options: InMemoryOptions = {}) =>
  Layer.mergeAll(
    options.http ?? RegistryHttpFixture(options.fixtures ?? {}, options.httpCalls),
    InMemoryRegistryRepository,
    InMemoryComponentRepository,
    InMemoryDirectoryRepository,
    InMemoryPipelineLog(options.events),
    InMemoryBlobStore,
    FakeDocWriter(options.agentFailFor ? { failFor: options.agentFailFor } : {}),
    options.demoWriter ?? FakeDemoWriter(),
    options.compiler ?? FakePreviewCompiler(options.previewFailFor ? { buildFailFor: options.previewFailFor } : {}),
    options.renderer ?? FakePreviewRenderer,
    options.agent ?? FakePreviewAgent(),
    options.themeAgent ?? FakeThemeAgent(),
    options.docs ?? FakeDocsReader(),
    InMemoryAgentRunLedger(options.agentRuns),
    FakeEmbedder,
    InMemoryTextSearchIndex,
    InMemoryVectorIndex,
    RecordingJobScheduler(options.jobs),
    InMemoryUsageLedger(options.usage),
    ExplorerConfigTest(options.config),
  )

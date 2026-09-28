import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import {
  collectPreviewBuild,
  enrichComponent,
  requestEnrichment,
  scheduleBacklog,
  startPreviewBuild,
  getComponentDetail,
  listRegistries,
  previewRegistration,
  registerRegistry,
  searchComponents,
  syncRegistry,
} from "../src/application/index.js"
import { ComponentId, RegistryId, UsageRecord, UserId, usd } from "../src/domain/index.js"
import { BlobStore, ComponentRepository, RegistryRepository } from "../src/ports/index.js"
import { type ScheduledJobs, makeInMemoryLayer, testConfig } from "../src/testing/index.js"

const INDEX = "https://acme.dev/r/registry.json"

const item = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  type: "registry:ui",
  title: name
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" "),
  files: [{ path: `registry/ui/${name}.tsx`, type: "registry:ui", content: `export function X() {}` }],
  ...extra,
})

const baseFixtures = (): Record<string, unknown> => ({
  "https://ui.shadcn.com/r/registries.json": [
    { name: "@acme", homepage: "https://acme.dev", url: "https://acme.dev/r/{name}.json", description: "Acme UI", health: { status: "healthy" } },
  ],
  [INDEX]: {
    name: "acme",
    homepage: "https://acme.dev",
    items: [
      { name: "glow-button", type: "registry:ui", description: "A shiny glowing button with gradient border" },
      { name: "data-table", type: "registry:block", description: "Sortable data table" },
      { name: "use-mounted", type: "registry:hook", description: "Hook returning mounted state" },
    ],
  },
  "https://acme.dev/r/glow-button.json": item("glow-button", {
    description: "A shiny glowing button with gradient border",
    categories: ["button"],
  }),
  "https://acme.dev/r/data-table.json": item("data-table", { type: "registry:block", description: "Sortable data table" }),
  "https://acme.dev/r/use-mounted.json": item("use-mounted", {
    type: "registry:hook",
    description: "Hook returning mounted state",
  }),
})

const setup = (
  overrides: { fixtures?: Record<string, unknown>; agentFailFor?: Array<string>; previewFailFor?: Array<string> } = {},
) => {
  const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
  const usage: Array<UsageRecord> = []
  const fixtures = overrides.fixtures ?? baseFixtures()
  const layer = makeInMemoryLayer({
    fixtures,
    jobs,
    usage,
    ...(overrides.agentFailFor ? { agentFailFor: overrides.agentFailFor } : {}),
    ...(overrides.previewFailFor ? { previewFailFor: overrides.previewFailFor } : {}),
  })
  return { jobs, usage, fixtures, layer }
}

/** 登録 → 同期 → 全件エンリッチ までを実行するヘルパ */
const ingestAll = (jobs: ScheduledJobs) =>
  Effect.gen(function* () {
    const registry = yield* registerRegistry("https://acme.dev", null)
    yield* syncRegistry(registry.id)
    for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
    return registry
  })

describe("registration flow", () => {
  it.effect("サイト URL から registry.json を探索し、確認情報とコスト見積もりを返す", () => {
    const { layer } = setup()
    return Effect.gen(function* () {
      const preview = yield* previewRegistration("https://acme.dev")
      expect(preview.name).toBe("acme")
      expect(preview.indexUrl).toBe(INDEX)
      expect(preview.namespace).toBe("@acme") // 公式ディレクトリから推定
      expect(preview.directoryHealth).toBe("healthy")
      expect(preview.itemCount).toBe(3)
      expect(preview.kinds).toEqual({ ui: 1, block: 1, hook: 1 })
      expect(preview.estimatedInitialCostUsd).toBeGreaterThan(0)
      expect(preview.alreadyRegistered).toBeNull()
    }).pipe(Effect.provide(layer))
  })

  it.effect("@namespace で登録でき、初回同期がスケジュールされる", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry("@acme", null)
      expect(registry.id).toBe("acme")
      expect(registry.namespace).toBe("@acme")
      expect(registry.status._tag).toBe("Pending")
      expect(jobs.syncs).toEqual(["acme"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("同じレジストリの二重登録は拒否する", () => {
    const { layer } = setup()
    return Effect.gen(function* () {
      yield* registerRegistry(INDEX, null)
      const error = yield* Effect.flip(registerRegistry("https://acme.dev/r/{name}.json", null))
      expect(error._tag).toBe("RegistryAlreadyRegistered")
    }).pipe(Effect.provide(layer))
  })

  it.effect("見つからなければ試した URL を返す", () => {
    const { layer } = setup()
    return Effect.gen(function* () {
      const error = yield* Effect.flip(registerRegistry("https://nothing.dev", null))
      expect(error).toMatchObject({
        _tag: "RegistryNotFound",
        tried: ["https://nothing.dev/r/registry.json", "https://nothing.dev/registry.json"],
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect("上限を超える巨大レジストリは拒否する", () => {
    const fixtures = baseFixtures()
    fixtures[INDEX] = {
      name: "huge",
      items: Array.from({ length: 501 }, (_, i) => ({ name: `c-${i}`, type: "registry:ui" })),
    }
    const { layer } = setup({ fixtures })
    return Effect.gen(function* () {
      const error = yield* Effect.flip(registerRegistry(INDEX, null))
      expect(error).toMatchObject({ _tag: "RegistryTooLarge", itemCount: 501, limit: 500 })
    }).pipe(Effect.provide(layer))
  })
})

describe("sync", () => {
  it.effect("初回同期で全件を保存し、エンリッチメントをスケジュールする", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* TestClock.adjust("1 seconds")
      const report = yield* syncRegistry(registry.id)
      expect(report).toMatchObject({ added: 3, changed: 0, removed: 0, scheduledForEnrichment: 3, warnings: [] })
      expect(jobs.enrichments).toHaveLength(3)

      const repo = yield* RegistryRepository
      const saved = Option.getOrThrow(yield* repo.findById(registry.id))
      expect(saved.status).toEqual({ _tag: "Active", lastSyncedAt: 1000, itemCount: 3 })
    }).pipe(Effect.provide(layer))
  })

  it.effect("再同期では変更・削除分だけを処理する", () => {
    const { layer, jobs, fixtures } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      jobs.enrichments.length = 0

      const index = fixtures[INDEX] as { items: Array<{ name: string }> }
      index.items = index.items.filter((i) => i.name !== "use-mounted")
      fixtures["https://acme.dev/r/glow-button.json"] = item("glow-button", { description: "Now with sparkles" })

      const report = yield* syncRegistry(registry.id)
      expect(report).toMatchObject({ added: 0, changed: 1, unchanged: 1, removed: 1 })
      expect(jobs.enrichments).toEqual(["acme:glow-button"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("一部のアイテム取得失敗は warnings に積み、同期は成功させる", () => {
    const fixtures = baseFixtures()
    delete fixtures["https://acme.dev/r/data-table.json"]
    const { layer } = setup({ fixtures })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      const report = yield* syncRegistry(registry.id)
      expect(report.added).toBe(2)
      expect(report.warnings).toHaveLength(1)
      expect(report.warnings[0]).toContain("data-table")
    }).pipe(Effect.provide(layer))
  })

  it.effect("インデックスが取れなければ Failed に遷移する", () => {
    const fixtures = baseFixtures()
    const { layer } = setup({ fixtures })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      delete fixtures[INDEX]
      const error = yield* Effect.flip(syncRegistry(registry.id))
      expect(error._tag).toBe("RegistryFetchError")
      const repo = yield* RegistryRepository
      const saved = Option.getOrThrow(yield* repo.findById(registry.id))
      expect(saved.status._tag).toBe("Failed")
    }).pipe(Effect.provide(layer))
  })
})

describe("enrichment", () => {
  it.effect("ドキュメント生成・スクショ・インデックスを行い、コストを記録する", () => {
    const { layer, jobs, usage } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const repo = yield* ComponentRepository
      const blobs = yield* BlobStore

      const button = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:glow-button")))
      expect(Option.isSome(button.doc)).toBe(true)
      expect(button.enrichment.doc._tag).toBe("Generated")
      expect(button.enrichment.preview._tag).toBe("Captured")
      expect(button.enrichment.index).toMatchObject({ _tag: "Indexed", withImage: true })
      if (button.enrichment.preview._tag === "Captured") {
        expect(Option.isSome(yield* blobs.get(button.enrichment.preview.lightKey))).toBe(true)
      }

      const hook = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:use-mounted")))
      expect(hook.enrichment.preview._tag).toBe("NotCaptured")
      expect(hook.enrichment.index).toMatchObject({ _tag: "Indexed", withImage: false })

      // ドキュメントは 3 件とも LLM、プレビューはビジュアルな 2 件だけ (hook は除外)
      expect(usage.filter((u) => u.category === "llm")).toHaveLength(3)
      expect(usage.filter((u) => u.category === "agent")).toHaveLength(2)
      expect(usage.filter((u) => u.category === "browser")).toHaveLength(2)
      expect(usage.every((u) => u.registryId === "acme")).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("変更がなければ 2 回目は何もしない", () => {
    const { layer, jobs, usage } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const before = usage.length
      const { plan, outcomes } = yield* enrichComponent(ComponentId.make("acme:glow-button"))
      expect(plan.steps).toEqual([])
      expect(outcomes).toEqual([])
      expect(usage.length).toBe(before)
    }).pipe(Effect.provide(layer))
  })

  it.effect("ドキュメント生成が失敗しても状態に記録し、プレビューとインデックスは続ける", () => {
    const { layer, jobs } = setup({ agentFailFor: ["data-table"] })
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const repo = yield* ComponentRepository
      const table = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:data-table")))
      expect(table.enrichment.doc).toMatchObject({ _tag: "Failed", attempts: 1 })
      expect(table.enrichment.preview._tag).toBe("Captured")
      expect(table.enrichment.index._tag).toBe("Indexed")
    }).pipe(Effect.provide(layer))
  })

  it.effect("プレビュービルドが失敗しても他のコンポーネント・ステップは止まらない", () => {
    const { layer, jobs } = setup({ previewFailFor: ["glow-button"] })
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const repo = yield* ComponentRepository
      const button = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:glow-button")))
      expect(button.enrichment.preview).toMatchObject({ _tag: "Failed", stage: "build", attempts: 1 })
      expect(button.enrichment.index).toMatchObject({ _tag: "Indexed", withImage: false })
      const table = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:data-table")))
      expect(table.enrichment.preview._tag).toBe("Captured")
    }).pipe(Effect.provide(layer))
  })

  it.effect("生成時にアイテム JSON を再取得しない (同期時に保存した原本を使う)", () => {
    const calls: Array<string> = []
    const fixtures = baseFixtures()
    const layer = makeInMemoryLayer({ fixtures, httpCalls: calls, jobs: { syncs: [], enrichments: [] } })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const before = calls.length
      // レジストリ側が消えても生成できる
      delete fixtures["https://acme.dev/r/glow-button.json"]
      const { outcomes } = yield* enrichComponent(ComponentId.make("acme:glow-button"))
      expect(outcomes.map((o) => o.outcome._tag)).toEqual(["Done", "Done", "Done", "Done"])
      expect(calls.length).toBe(before)
    }).pipe(Effect.provide(layer))
  })

  it.effect("インデックスに内容が同梱されたレジストリ (個別 JSON 無し) でも生成できる", () => {
    const fixtures: Record<string, unknown> = {
      "https://ui.shadcn.com/r/registries.json": [],
      [INDEX]: {
        name: "inline",
        items: [{ name: "badge", type: "registry:ui", files: [{ path: "badge.tsx", content: "export const Badge = 1" }] }],
      },
    }
    const { layer, jobs } = setup({ fixtures })
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const repo = yield* ComponentRepository
      const badge = Option.getOrThrow(yield* repo.findById(ComponentId.make("inline:badge")))
      expect(badge.enrichment.doc._tag).toBe("Generated")
    }).pipe(Effect.provide(layer))
  })

  it.effect("プレビュービルドは start → poll の 2 段階で進む (Workflow が間で待てる)", () => {
    const layer = makeInMemoryLayer({ fixtures: baseFixtures(), previewPollsUntilDone: 3 })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      const job = Option.getOrThrow(yield* startPreviewBuild(id))
      expect(Option.isNone(yield* collectPreviewBuild(id, job))).toBe(true)
      expect(Option.isNone(yield* collectPreviewBuild(id, job))).toBe(true)
      expect(Option.getOrThrow(yield* collectPreviewBuild(id, job))._tag).toBe("Done")
      const repo = yield* ComponentRepository
      expect(Option.getOrThrow(yield* repo.findById(id)).enrichment.preview._tag).toBe("Built")
    }).pipe(Effect.provide(layer))
  })

  it.effect("予算上限に達していたら何も実行しない", () => {
    const { layer, jobs, usage } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      usage.push(new UsageRecord({ category: "agent", amount: usd(50), subject: "x", detail: {}, at: 0 }))
      const { plan, outcomes } = yield* enrichComponent(jobs.enrichments[0]!)
      expect(plan.decision._tag).toBe("Defer")
      expect(outcomes).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("backlog & quotas", () => {
  it.effect("予算で後回しにされたものを backlog sweeper が拾い直す", () => {
    const { layer, jobs, usage } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      jobs.enrichments.length = 0
      // ソースは変わっていないので再同期では何も投入されない
      yield* syncRegistry(registry.id)
      expect(jobs.enrichments).toEqual([])
      const swept = yield* scheduleBacklog()
      expect(swept).toEqual({ scanned: 3, scheduled: 3 })
      // 予算上限なら何もしない
      jobs.enrichments.length = 0
      usage.push(new UsageRecord({ category: "llm", amount: usd(50), subject: "x", detail: {}, at: 0 }))
      expect(yield* scheduleBacklog()).toEqual({ scanned: 0, scheduled: 0 })
    }).pipe(Effect.provide(layer))
  })

  it.effect("ユーザー別の月次アイテム数上限を超える登録は拒否する", () => {
    const fixtures = baseFixtures()
    fixtures["https://other.dev/r/registry.json"] = { name: "other", items: [{ name: "x", type: "registry:ui" }, { name: "y", type: "registry:ui" }] }
    const layer = makeInMemoryLayer({ fixtures, config: { budget: { ...testConfig.budget, maxItemsPerUserPerMonth: 4 } } })
    return Effect.gen(function* () {
      const user = UserId.make("u1")
      yield* registerRegistry(INDEX, user) // 3 items
      const error = yield* Effect.flip(registerRegistry("https://other.dev/r/registry.json", user)) // +2 > 4
      expect(error).toMatchObject({ _tag: "UserQuotaExceeded", used: 3, requested: 2, limit: 4 })
      // 別ユーザーは影響を受けない
      yield* registerRegistry("https://other.dev/r/registry.json", UserId.make("u2"))
    }).pipe(Effect.provide(layer))
  })
})

describe("manual enrichment", () => {
  it.effect("登録者は失敗したドキュメント生成を再要求でき、失敗状態がリセットされる", () => {
    const { layer, jobs } = setup({ agentFailFor: ["data-table"] })
    return Effect.gen(function* () {
      const owner = UserId.make("u1")
      const registry = yield* registerRegistry(INDEX, owner)
      yield* syncRegistry(registry.id)
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      const id = ComponentId.make("acme:data-table")
      yield* requestEnrichment(id, owner)
      expect(jobs.enrichments).toEqual([id])
      const repo = yield* ComponentRepository
      expect(Option.getOrThrow(yield* repo.findById(id)).enrichment.doc._tag).toBe("NotGenerated")
    }).pipe(Effect.provide(layer))
  })

  it.effect("登録者以外は再生成を要求できない", () => {
    const { layer } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, UserId.make("u1"))
      yield* syncRegistry(registry.id)
      const error = yield* Effect.flip(requestEnrichment(ComponentId.make("acme:glow-button"), UserId.make("u2")))
      expect(error._tag).toBe("NotRegistryOwner")
    }).pipe(Effect.provide(layer))
  })
})

describe("search & queries", () => {
  it.effect("ハイブリッド検索で複数ソースを融合する", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const semantic = yield* searchComponents({ _tag: "Text", text: "glowing button", mode: "semantic", filters: {}, limit: 10 })
      expect(semantic.hits[0]?.sources).toEqual(["semantic"])
      const result = yield* searchComponents({
        _tag: "Text",
        text: "glowing button",
        mode: "hybrid",
        filters: {},
        limit: 10,
      })
      expect(result.warnings).toEqual([])
      expect(result.hits[0]?.record.snapshot.name).toBe("glow-button")
      expect(result.hits[0]?.sources).toEqual(expect.arrayContaining(["keyword", "semantic", "visual-text"]))
    }).pipe(Effect.provide(layer))
  })

  it.effect("種別フィルタが効く", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const result = yield* searchComponents({
        _tag: "Text",
        text: "table button hook",
        mode: "keyword",
        filters: { kinds: ["hook"] },
        limit: 10,
      })
      expect(result.hits.map((h) => h.record.snapshot.name)).toEqual(["use-mounted"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("画像検索: アップロード画像に近いスクショを返す", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const blobs = yield* BlobStore
      yield* blobs.put("uploads/q.png", new TextEncoder().encode("Sortable data table"), "image/png")
      const result = yield* searchComponents({ _tag: "Image", imageKey: "uploads/q.png", filters: {}, limit: 5 })
      expect(result.hits[0]?.record.snapshot.name).toBe("data-table")
      expect(result.hits[0]?.sources).toEqual(["visual-image"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("コンポーネント詳細はインストールコマンドを名前空間付きで返す", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const detail = yield* getComponentDetail(ComponentId.make("acme:glow-button"))
      expect(detail.installCommand).toBe("npx shadcn@latest add @acme/glow-button")
      const registries = yield* listRegistries
      expect(registries).toMatchObject([{ registry: { id: RegistryId.make("acme") }, componentCount: 3 }])
    }).pipe(Effect.provide(layer))
  })
})

describe("layer composition", () => {
  it("makeInMemoryLayer は全ポートを提供する", () => {
    const layer = makeInMemoryLayer()
    expect(Layer.isLayer(layer)).toBe(true)
  })
})

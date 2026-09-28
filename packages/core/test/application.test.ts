import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import {
  enrichComponent,
  getComponentDetail,
  listRegistries,
  previewRegistration,
  registerRegistry,
  searchComponents,
  syncRegistry,
} from "../src/application/index.js"
import { ComponentId, RegistryId, type UsageRecord, usd } from "../src/domain/index.js"
import { BlobStore, ComponentRepository, RegistryRepository } from "../src/ports/index.js"
import { type ScheduledJobs, makeInMemoryLayer } from "../src/testing/index.js"

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

const setup = (overrides: { fixtures?: Record<string, unknown>; agentFailFor?: Array<string> } = {}) => {
  const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
  const usage: Array<UsageRecord> = []
  const fixtures = overrides.fixtures ?? baseFixtures()
  const layer = makeInMemoryLayer({
    fixtures,
    jobs,
    usage,
    ...(overrides.agentFailFor ? { agentFailFor: overrides.agentFailFor } : {}),
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

      expect(usage.filter((u) => u.category === "agent")).toHaveLength(3)
      expect(usage.filter((u) => u.category === "browser")).toHaveLength(2)
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

  it.effect("Agent が失敗しても状態に記録し、テキストだけはインデックスする", () => {
    const { layer, jobs } = setup({ agentFailFor: ["data-table"] })
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const repo = yield* ComponentRepository
      const table = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:data-table")))
      expect(table.enrichment.doc).toMatchObject({ _tag: "Failed", attempts: 1 })
      expect(table.enrichment.preview._tag).toBe("Skipped")
      expect(table.enrichment.index._tag).toBe("Indexed")
    }).pipe(Effect.provide(layer))
  })

  it.effect("予算上限に達していたら何も実行しない", () => {
    const { layer, jobs, usage } = setup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      usage.push({ category: "agent", amount: usd(50), subject: "x", detail: {}, at: 0 } as UsageRecord)
      const { plan, outcomes } = yield* enrichComponent(jobs.enrichments[0]!)
      expect(plan.decision._tag).toBe("Defer")
      expect(outcomes).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("search & queries", () => {
  it.effect("ハイブリッド検索で複数ソースを融合する", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
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

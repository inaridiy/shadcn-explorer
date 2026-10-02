import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Option, TestClock } from "effect"
import {
  browseGallery,
  captureVariant,
  isImmutableShotKey,
  listComponentCards,
  screenshotKey,
  compileDemo,
  enrichComponent,
  generateDemo,
  repairDemo,
  requestEnrichment,
  scheduleBacklog,
  updateRegistryPreviewConfig,
  getComponentDetail,
  listRegistries,
  previewRegistration,
  registerRegistry,
  searchComponents,
  similarComponents,
  syncRegistry,
} from "../src/application/index.js"
import { ComponentId, RegistryId, UsageRecord, UserId, usd } from "../src/domain/index.js"
import { type AgentRun, BlobStore, ComponentRepository, RegistryRepository } from "../src/ports/index.js"
import {
  ExplorerConfigTest,
  FakeDemoWriter,
  FakePreviewAgent,
  FakePreviewCompiler,
  FakePreviewRendererWith,
  type RecordedCapture,
  type ScheduledJobs,
  makeInMemoryLayer,
  testConfig,
} from "../src/testing/index.js"

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

/** エージェントへの委譲を無効にした設定 (決まった手順だけの振る舞いを見るテスト用) */
const noAgent = { previewBuild: { ...testConfig.previewBuild, agent: null } }

const setup = (
  overrides: {
    fixtures?: Record<string, unknown>
    agentFailFor?: Array<string>
    previewFailFor?: Array<string>
    config?: Partial<typeof testConfig>
  } = {},
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
    ...(overrides.config ? { config: overrides.config } : {}),
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

  it.effect("一時的に取得できなかったアイテムは削除しない (エンリッチ結果を払い直さない)", () => {
    const fixtures = baseFixtures()
    const { layer, jobs } = setup({ fixtures })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      jobs.enrichments.length = 0

      const dataTable = fixtures["https://acme.dev/r/data-table.json"]
      delete fixtures["https://acme.dev/r/data-table.json"]
      const report = yield* syncRegistry(registry.id)
      expect(report).toMatchObject({ added: 0, changed: 0, removed: 0 })
      const repo = yield* ComponentRepository
      expect(Option.isSome(yield* repo.findById(ComponentId.make("acme:data-table")))).toBe(true)

      // 取得できるようになっても、内容が同じなら何も投入しない
      fixtures["https://acme.dev/r/data-table.json"] = dataTable
      expect(yield* syncRegistry(registry.id)).toMatchObject({ added: 0, unchanged: 3 })
      expect(jobs.enrichments).toEqual([])
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
        const { lightKey, embedImages } = button.enrichment.preview
        expect(lightKey).toMatch(/\.webp$/)
        expect(Option.isSome(yield* blobs.get(lightKey))).toBe(true)
        // 画像埋め込みは WebP ではなく JPEG から
        expect(embedImages?.lightKey).toMatch(/\.jpg$/)
        expect(Option.isSome(yield* blobs.get(embedImages!.lightKey))).toBe(true)
      }

      const hook = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:use-mounted")))
      expect(hook.enrichment.preview._tag).toBe("NotCaptured")
      expect(hook.enrichment.index).toMatchObject({ _tag: "Indexed", withImage: false })

      // ドキュメントは 3 件とも LLM、プレビュー (デモ LLM + ビルド) はビジュアルな 2 件だけ (hook は除外)
      expect(usage.filter((u) => u.category === "llm" && !("demo" in u.detail))).toHaveLength(3)
      expect(usage.filter((u) => u.category === "llm" && "demo" in u.detail)).toHaveLength(2)
      // コンテナ: ビルド 2 回 + 撮影 2 回 (撮影もコンテナ内の Playwright)
      expect(usage.filter((u) => u.category === "sandbox")).toHaveLength(4)
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
    const { layer, jobs } = setup({ previewFailFor: ["glow-button"], config: noAgent })
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const repo = yield* ComponentRepository
      const button = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:glow-button")))
      expect(button.enrichment.preview).toMatchObject({ _tag: "Failed", stage: "build", cause: "demo", attempts: 1 })
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

  it.effect("デモは生成 → コンパイル ⇄ 修正の段階に分かれ、Workflow が各段を別ステップにできる", () => {
    const layer = makeInMemoryLayer({ fixtures: baseFixtures(), demoWriter: FakeDemoWriter({ lintFailFor: ["glow-button"] }) })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      const repo = yield* ComponentRepository
      expect(Option.getOrThrow(yield* generateDemo(id))).toBe(0)
      // 初回のデモは見出し付き (lint 違反) → コンテナを使わずに修正へ回る
      const first = yield* compileDemo(id, 0)
      expect(first._tag).toBe("Repair")
      expect(first._tag === "Repair" && first.problems.join(" ")).toMatch(/headings/)
      const next = Option.getOrThrow(yield* repairDemo(id, 0, first._tag === "Repair" ? first.problems : []))
      expect(next).toBe(1)
      expect((yield* compileDemo(id, 1))._tag).toBe("Done")
      const preview = Option.getOrThrow(yield* repo.findById(id)).enrichment.preview
      expect(preview).toMatchObject({ _tag: "Built" })
      expect(preview._tag === "Built" && preview.demoKey).toMatch(/-1\.tsx$/)
    }).pipe(Effect.provide(layer))
  })

  it.effect("型エラーが残るビルドも一旦 Built にし、修正版で置き換える", () => {
    const calls: Array<string> = []
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      compiler: FakePreviewCompiler({ diagnosticsOnceFor: ["glow-button"], calls }),
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      yield* enrichComponent(id)
      expect(calls).toEqual(["glow-button", "glow-button"])
      const preview = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      expect(preview._tag).toBe("Captured")
      expect(preview._tag === "Captured" && preview.demoKey).toMatch(/-1\.tsx$/)
    }).pipe(Effect.provide(layer))
  })

  it.effect("ビルドが直らなければ修正回数 (maxRepairs) で打ち切り、アイテムが入らなければ修正しない", () => {
    const calls: Array<string> = []
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      compiler: FakePreviewCompiler({ buildFailFor: ["glow-button"], installFailFor: ["data-table"], calls }),
      config: noAgent,
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      yield* enrichComponent(ComponentId.make("acme:glow-button"))
      yield* enrichComponent(ComponentId.make("acme:data-table"))
      expect(calls.filter((c) => c === "glow-button")).toHaveLength(testConfig.previewBuild.maxRepairs + 1)
      expect(calls.filter((c) => c === "data-table")).toHaveLength(1)
      const repo = yield* ComponentRepository
      const button = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:glow-button")))
      expect(button.enrichment.preview).toMatchObject({ _tag: "Failed", stage: "build", cause: "demo", attempts: 1 })
      const table = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:data-table")))
      expect(table.enrichment.preview).toMatchObject({ _tag: "Failed", stage: "build", cause: "registry" })
      expect(table.enrichment.preview._tag === "Failed" && table.enrichment.preview.error).toMatch(/^install/)
    }).pipe(Effect.provide(layer))
  })

  it.effect("決まった手順で直せないアイテムはエージェントに 1 回だけ回し、手順 (manifest) をこちらで再ビルドする", () => {
    const calls: Array<string> = []
    const started: Array<string> = []
    const agentRuns: Array<AgentRun> = []
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      compiler: FakePreviewCompiler({ registryBrokenFor: ["glow-button"], calls }),
      agent: FakePreviewAgent({ started }),
      agentRuns,
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      yield* enrichComponent(id)
      // 決まった手順 1 回 (registry 起因なのでデモの修正はしない) + エージェントの手順での再ビルド 1 回
      expect(calls).toEqual(["glow-button", "glow-button"])
      expect(started).toEqual(["glow-button"])
      const preview = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      expect(preview).toMatchObject({ _tag: "Captured", buildKind: "agent", workarounds: ["writeFile"] })
      const blobs = yield* BlobStore
      expect(Option.isSome(yield* blobs.get((preview as { manifestKey: string }).manifestKey))).toBe(true)
      expect(agentRuns.map((r) => r.outcome)).toEqual(["succeeded"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("エージェントが諦めたら escalated を立て、同じソース・版では再試行も再委譲もしない", () => {
    const started: Array<string> = []
    const agentRuns: Array<AgentRun> = []
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      compiler: FakePreviewCompiler({ registryBrokenFor: ["glow-button"] }),
      agent: FakePreviewAgent({ started, gaveUpFor: ["glow-button"] }),
      agentRuns,
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      yield* enrichComponent(id)
      const preview = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      expect(preview).toMatchObject({ _tag: "Failed", cause: "registry", escalated: true })
      const again = yield* enrichComponent(id)
      expect(again.plan.steps.map((s) => s._tag)).not.toContain("BuildPreview")
      expect(started).toEqual(["glow-button"])
      expect(agentRuns.map((r) => r.outcome)).toEqual(["gave_up"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("エージェントの手順が許可リスト外なら採用しない", () => {
    const agentRuns: Array<AgentRun> = []
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      compiler: FakePreviewCompiler({ registryBrokenFor: ["glow-button"] }),
      agent: FakePreviewAgent({ manifest: { actions: [{ type: "writeFile", path: "../main.tsx", content: "" }] } }),
      agentRuns,
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      yield* enrichComponent(id)
      const preview = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      expect(preview).toMatchObject({ _tag: "Failed", escalated: true })
      expect(agentRuns.map((r) => r.outcome)).toEqual(["rejected"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("エージェントはレジストリ単位の上限を超えて呼ばない", () => {
    const started: Array<string> = []
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      compiler: FakePreviewCompiler({ registryBrokenFor: ["glow-button", "data-table"] }),
      agent: FakePreviewAgent({ started }),
      // 3 件 × 0.25 → 上限 1 件
      config: { previewBuild: { ...testConfig.previewBuild, agent: { ...testConfig.previewBuild.agent!, maxRatio: 0.25 } } },
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      yield* enrichComponent(ComponentId.make("acme:glow-button"))
      yield* enrichComponent(ComponentId.make("acme:data-table"))
      expect(started).toEqual(["glow-button"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("動き続ける部品は animated WebP も保存し、描画時の例外は demo 起因のビルド失敗にする", () => {
    const layer = makeInMemoryLayer({
      fixtures: baseFixtures(),
      renderer: FakePreviewRendererWith({ animatedFor: ["Glow Button"], runtimeErrorFor: ["Data Table"] }),
      config: noAgent,
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const repo = yield* ComponentRepository
      const blobs = yield* BlobStore
      yield* enrichComponent(ComponentId.make("acme:glow-button"))
      yield* enrichComponent(ComponentId.make("acme:data-table"))
      const button = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:glow-button"))).enrichment.preview
      expect(button._tag).toBe("Captured")
      if (button._tag === "Captured") {
        expect(button.motion?.lightKey).toMatch(/\.webp$/)
        expect(button.motion?.lightKey).not.toBe(button.lightKey)
        expect(Option.isSome(yield* blobs.get(button.motion!.lightKey))).toBe(true)
      }
      const table = Option.getOrThrow(yield* repo.findById(ComponentId.make("acme:data-table"))).enrichment.preview
      expect(table).toMatchObject({ _tag: "Failed", stage: "build", cause: "demo" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("撮影方式の版だけ上がったら撮り直すだけで、ビルドの由来は引き継ぐ", () => {
    const calls: Array<string> = []
    const { jobs } = setup()
    const base = { fixtures: baseFixtures(), jobs, compiler: FakePreviewCompiler({ calls }) }
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      const id = ComponentId.make("acme:glow-button")
      yield* enrichComponent(id)
      const before = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      const next = { ...testConfig.enrichment, captureVersion: "cap-next" }
      const { plan } = yield* enrichComponent(id).pipe(
        Effect.provide(ExplorerConfigTest({ enrichment: next })),
      )
      expect(plan.steps.map((s) => s._tag)).toEqual(["CapturePreview", "Index"])
      const after = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      expect(calls).toEqual(["glow-button"])
      expect(after).toMatchObject({ _tag: "Captured", captureVersion: "cap-next", demoKey: (before as { demoKey: string }).demoKey })
      expect((after as { lightKey: string }).lightKey).not.toBe((before as { lightKey: string }).lightKey)
    }).pipe(Effect.provide(makeInMemoryLayer(base)))
  })

  it.effect("ビルド設定を変えるとビルドし直すが、デモは書き直さない", () => {
    const demoCalls: Array<string> = []
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({ fixtures: baseFixtures(), jobs, demoWriter: FakeDemoWriter({ calls: demoCalls }) })
    return Effect.gen(function* () {
      const registry = yield* ingestAll(jobs)
      expect(demoCalls.sort()).toEqual(["data-table", "glow-button"])

      const result = yield* updateRegistryPreviewConfig(registry.id, { themeCss: ":root{--main:#88aaee}", pins: { "lucide-react": "0.525.0" } })
      expect(result.rebuilding).toBe(2) // ボタンとテーブル (hook は対象外)
      const saved = Option.getOrThrow(yield* (yield* RegistryRepository).findById(registry.id))
      expect(saved.previewConfig).toEqual({ themeCss: ":root{--main:#88aaee}", pins: { "lucide-react": "0.525.0" } })
      expect(saved.theme).toMatchObject({ _tag: "Resolved", source: "manual" })
      // 状態は書き換えず、計画がハッシュの違いを見てビルドし直す
      const id = ComponentId.make("acme:glow-button")
      expect(Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview._tag).toBe("Captured")
      expect(jobs.enrichments).toHaveLength(2)
      const { plan } = yield* enrichComponent(id)
      expect(plan.steps.map((s) => s._tag)).toEqual(["BuildPreview", "CapturePreview", "Index"])
      expect(demoCalls.filter((n) => n === "glow-button")).toHaveLength(1)
      expect(Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview._tag).toBe("Captured")
      // もう一度計画しても何もしない
      expect((yield* enrichComponent(id)).plan.steps).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("トークンだけ変えたら撮り直すだけで、撮影時に注入する。ダークの無いテーマはライトだけ撮る", () => {
    const captures: Array<RecordedCapture> = []
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({ fixtures: baseFixtures(), jobs, renderer: FakePreviewRendererWith({ captures }) })
    return Effect.gen(function* () {
      const registry = yield* ingestAll(jobs)
      captures.length = 0
      const tokens = { light: { "--primary": "#5294ff", "--background": "#dcebfe", "--foreground": "#000000" } }
      yield* updateRegistryPreviewConfig(registry.id, { tokens })
      const id = ComponentId.make("acme:glow-button")
      const { plan } = yield* enrichComponent(id)
      expect(plan.steps.map((s) => s._tag)).toEqual(["CapturePreview", "Index"])
      expect(captures).toEqual([{ schemes: ["light"], tokens }])
      const preview = Option.getOrThrow(yield* (yield* ComponentRepository).findById(id)).enrichment.preview
      expect(preview).toMatchObject({ _tag: "Captured", darkKey: null, runtimeTokens: true })
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
  it.effect("失敗したドキュメント生成を再要求でき、失敗状態がリセットされる", () => {
    const { layer, jobs } = setup({ agentFailFor: ["data-table"] })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry(INDEX, null)
      yield* syncRegistry(registry.id)
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      const id = ComponentId.make("acme:data-table")
      yield* requestEnrichment(id)
      expect(jobs.enrichments).toEqual([id])
      const repo = yield* ComponentRepository
      expect(Option.getOrThrow(yield* repo.findById(id)).enrichment.doc._tag).toBe("NotGenerated")
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
      expect(result.hits[0]?.card.name).toBe("glow-button")
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
      expect(result.hits.map((h) => h.card.name)).toEqual(["use-mounted"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("画像検索: アップロード画像に近いスクショを返す", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const blobs = yield* BlobStore
      yield* blobs.put("uploads/q.png", new TextEncoder().encode("Sortable data table"), "image/png")
      const result = yield* searchComponents({ _tag: "Image", imageKey: "uploads/q.png", filters: {}, limit: 5 })
      expect(result.hits[0]?.card.name).toBe("data-table")
      expect(result.hits[0]?.sources).toEqual(["visual-image"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("よそで似ているもの: スクショのベクトルで他のレジストリだけから返す", () => {
    const fixtures = baseFixtures()
    const BETA = "https://beta.dev/r/registry.json"
    fixtures[BETA] = {
      name: "beta",
      items: [
        { name: "glossy-button", type: "registry:ui", description: "A shiny glowing button with soft border" },
        { name: "pricing-table", type: "registry:block", description: "Pricing table with tiers" },
      ],
    }
    fixtures["https://beta.dev/r/glossy-button.json"] = item("glossy-button", { description: "A shiny glowing button with soft border" })
    fixtures["https://beta.dev/r/pricing-table.json"] = item("pricing-table", { type: "registry:block", description: "Pricing table with tiers" })
    const { layer, jobs } = setup({ fixtures })
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const beta = yield* registerRegistry(BETA, null)
      yield* syncRegistry(beta.id)
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)

      const similar = yield* similarComponents(ComponentId.make("acme:glow-button"), 4)
      expect(similar.map((c) => c.id)).toEqual(["beta:glossy-button", "beta:pricing-table"])
      // 自分のレジストリ (acme) のものは出さない
      expect(similar.every((c) => c.registryId === "beta")).toBe(true)
      // スクショの無い hook はベクトルも無いので空
      expect(yield* similarComponents(ComponentId.make("acme:use-mounted"), 4)).toEqual([])
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

describe("gallery and cards", () => {
  it.effect("ギャラリーはプレビューのあるものだけを、keyset でページングして返す", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      yield* ingestAll(jobs)
      const first = yield* browseGallery({ limit: 1 })
      expect(first.cards).toHaveLength(1)
      expect(first.next).not.toBeNull()
      const second = yield* browseGallery({ limit: 1, after: first.next! })
      expect(second.cards).toHaveLength(1)
      expect(second.next).toBeNull()
      // hook はプレビューを作らないのでギャラリーには出ない
      const names = [...first.cards, ...second.cards].map((c) => c.name).sort()
      expect(names).toEqual(["data-table", "glow-button"])
      expect(first.cards[0]!.stills?.light).toMatch(/^screenshots\//)
    }).pipe(Effect.provide(layer))
  })

  it.effect("カードの一覧は hook も含めて名前順に返す", () => {
    const { layer, jobs } = setup()
    return Effect.gen(function* () {
      const registry = yield* ingestAll(jobs)
      const cards = yield* listComponentCards({ registryId: registry.id, limit: 10, offset: 0 })
      expect(cards.map((c) => c.name)).toEqual(["data-table", "glow-button", "use-mounted"])
      expect(cards.find((c) => c.name === "use-mounted")?.stills).toBeNull()
    }).pipe(Effect.provide(layer))
  })

  it("見た目の設定の版 (variant) が入ったスクショのキーだけを immutable とみなす", () => {
    const id = ComponentId.make("acme:glow-button")
    const variant = captureVariant({ configHash: "a1b2c3d4e5f6a7", tokensHash: "0f1e2d3c4b5a69" })
    expect(variant).toBe("a1b2c3d0f1e2d3")
    expect(isImmutableShotKey(screenshotKey(id, "abc.demo-v2", "cap-v8", "light", variant))).toBe(true)
    expect(isImmutableShotKey(screenshotKey(id, "abc.demo-v2", "cap-v7", "dark"))).toBe(false)
    expect(isImmutableShotKey("previews/acme/glow-button/abc.html")).toBe(false)
  })
})


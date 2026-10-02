import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import {
  approveThemeProposal,
  collectThemeAgent,
  enrichComponent,
  registerRegistry,
  rejectThemeProposal,
  startThemeAgent,
  syncRegistry,
  updateRegistryPreviewConfig,
} from "../src/application/index.js"
import {
  ComponentId,
  EnrichmentState,
  buildConfigHash,
  contrastRatio,
  detectThemeFromItems,
  parseColor,
  planEnrichment,
  previewSourceHash,
  BUILD_VERSION,
  CAPTURE_VERSION,
  tokensFromCssVars,
  validateThemeConfig,
} from "../src/domain/index.js"
import { ComponentRepository, RegistryRepository, type ThemeAgentInput } from "../src/ports/index.js"
import {
  FakeDemoWriter,
  FakeDocsReader,
  FakePreviewRendererWith,
  type RecordedCapture,
  FakeThemeAgent,
  type ScheduledJobs,
  makeInMemoryLayer,
} from "../src/testing/index.js"

const INDEX = "https://acme.dev/r/registry.json"

const ui = (name: string) => ({
  name,
  type: "registry:ui",
  files: [{ path: `registry/ui/${name}.tsx`, type: "registry:ui", content: "export function X() {}" }],
})

const fixtures = (extraItems: ReadonlyArray<Record<string, unknown>> = []): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    "https://ui.shadcn.com/r/registries.json": [{ name: "@acme", homepage: "https://acme.dev", url: "https://acme.dev/r/{name}.json" }],
    [INDEX]: { name: "acme", homepage: "https://acme.dev", items: [ui("button"), ui("card"), ...extraItems].map((i) => ({ name: i.name, type: i.type })) },
    "https://acme.dev/r/button.json": ui("button"),
    "https://acme.dev/r/card.json": ui("card"),
  }
  for (const i of extraItems) out[`https://acme.dev/r/${String(i.name)}.json`] = i
  return out
}

const style = (name: string, cssVars: unknown = { light: { background: "#dcebfe", foreground: "#000000", main: "#5294ff" } }) => ({
  name,
  type: "registry:style",
  cssVars,
})

// ---------------------------------------------------------------------------
// domain
// ---------------------------------------------------------------------------

describe("theme domain", () => {
  it("cssVars をトークンにする (-- を付け、外部参照や不正な値は落とす)", () => {
    expect(
      tokensFromCssVars({
        light: { background: "oklch(1 0 0)", "--radius": "0.5rem", evil: "url(https://x)", bad: "red; } body { x" },
        dark: { background: "oklch(0.1 0 0)" },
        theme: { "font-sans": "Inter" },
      }),
    ).toEqual({ light: { "--background": "oklch(1 0 0)", "--radius": "0.5rem" }, dark: { "--background": "oklch(0.1 0 0)" } })
    expect(tokensFromCssVars({ theme: { x: "1" } })).toBeNull()
  })

  it("registry.json のテーマ系アイテムからテーマを決める", () => {
    const at = (item: { name: string }) => ({ item: item as never, url: `https://acme.dev/r/${item.name}.json` })
    expect(detectThemeFromItems([at(ui("button"))])._tag).toBe("NoCandidates")
    expect(detectThemeFromItems([at(style("index", {}))])).toMatchObject({ _tag: "Neutral", item: "index" })
    expect(detectThemeFromItems(Array.from({ length: 6 }, (_, i) => at(style(`t${i}`))))).toMatchObject({ _tag: "Collection", count: 6 })

    const single = detectThemeFromItems([at(style("blue"))])
    expect(single).toMatchObject({
      _tag: "Detected",
      auto: true,
      proposal: {
        source: "registry-item",
        confidence: "high",
        config: { baseItems: ["https://acme.dev/r/blue.json"], tokens: { light: { "--background": "#dcebfe" } } },
      },
    })

    const two = detectThemeFromItems([at(style("blue")), at(style("red", { light: { background: "#fee", foreground: "#000" } }))])
    expect(two).toMatchObject({ _tag: "Detected", auto: false, proposal: { confidence: "medium" } })
    expect(two._tag === "Detected" && two.proposal.config.variants?.map((v) => v.name)).toEqual(["blue", "red"])
  })

  it("提案の検証: レジストリ以外のホスト・外部参照・コントラスト不足を落とす。手入力はホストを問わない", () => {
    const scope = { registryUrls: ["https://acme.dev", "https://acme.dev/r/registry.json"], namespace: "@acme" }
    expect(validateThemeConfig({ baseItems: ["https://docs.acme.dev/r/styling/blue.json", "@acme/theme"] }, scope)).toEqual([])
    expect(validateThemeConfig({ baseItems: ["https://evil.dev/r/x.json"] }, scope)[0]).toContain("not hosted by the registry")
    expect(validateThemeConfig({ baseItems: ["@other/theme"] }, scope)[0]).toContain("namespace")
    expect(validateThemeConfig({ css: "@import url(https://x.dev/a.css);" }, scope).length).toBeGreaterThan(0)
    expect(validateThemeConfig({ tokens: { light: { "--background": "#ffffff", "--foreground": "#eeeeee" } } }, scope)[0]).toContain("contrast")
    expect(validateThemeConfig({ baseItems: ["https://evil.dev/r/x.json"] }, null)).toEqual([])
    // 共有ホスティング (raw.githubusercontent.com) はオーナー/リポジトリまで一致させる
    const gh = { registryUrls: ["https://raw.githubusercontent.com/Delego-Dev/registry/main/public/r/registry.json"], namespace: null }
    expect(validateThemeConfig({ baseItems: ["https://raw.githubusercontent.com/Delego-Dev/registry/main/public/r/theme.json"] }, gh)).toEqual([])
    expect(validateThemeConfig({ baseItems: ["https://raw.githubusercontent.com/someone/else/main/r/theme.json"] }, gh)[0]).toContain("not hosted")
    expect(validateThemeConfig({ themeVars: { "--color-main": "var(--main)", "--evil": "x" } }, null)[0]).toContain("themeVars")
  })

  it("色の解釈とコントラスト (oklch / hex / shadcn v3 の hsl 成分)", () => {
    expect(contrastRatio(parseColor("oklch(1 0 0)")!, parseColor("oklch(0 0 0)")!)).toBeGreaterThan(20)
    expect(contrastRatio(parseColor("#fff")!, parseColor("0 0% 0%")!)).toBeGreaterThan(20)
    expect(parseColor("var(--x)")).toBeNull()
  })

  it("計画: 設定が変わればビルドし直し、トークンだけなら撮り直し、保留中はプレビューを作らない", () => {
    const hash = previewSourceHash("h", BUILD_VERSION)
    const captured = (extra: Record<string, unknown>) =>
      new EnrichmentState({
        doc: { _tag: "Generated", sourceHash: "h", agentPreset: "x", generatedAt: 0 },
        preview: { _tag: "Captured", sourceHash: hash, lightKey: "l", darkKey: "d", htmlKey: "h", captureVersion: CAPTURE_VERSION, capturedAt: 0, ...extra },
        index: { _tag: "Indexed", sourceHash: "h", withImage: true, indexedAt: 0 },
      })
    const snapshot = { kind: "ui" as const, contentHash: "h" }
    const policy = { maxAttempts: 3, capturePreviews: true, buildVersion: BUILD_VERSION, captureVersion: CAPTURE_VERSION }
    const ctx = { configHash: "c1", tokensHash: "t1", onHold: false }
    const tags = (state: EnrichmentState, c = ctx) => planEnrichment(snapshot, state, policy, c).map((s) => s._tag)

    expect(tags(captured({}))).toEqual([]) // v0.5 以前 (ハッシュなし) は今の設定で作ったとみなす
    expect(tags(captured({ configHash: "c1", tokensHash: "t1" }))).toEqual([])
    expect(tags(captured({ configHash: "c0", tokensHash: "t1" }))).toEqual(["BuildPreview", "CapturePreview", "Index"])
    expect(tags(captured({ configHash: "c1", tokensHash: "t0", runtimeTokens: true }))).toEqual(["CapturePreview", "Index"])
    expect(tags(captured({ configHash: "c1", tokensHash: "t0" }))).toEqual(["BuildPreview", "CapturePreview", "Index"])
    expect(tags(EnrichmentState.initial, { ...ctx, onHold: true })).toEqual(["GenerateDoc", "Index"])
    expect(buildConfigHash({ tokens: { light: { "--a": "1" } } })).toBe(buildConfigHash({}))
  })
})

// ---------------------------------------------------------------------------
// application
// ---------------------------------------------------------------------------

const ingest = (jobs: ScheduledJobs) =>
  Effect.gen(function* () {
    const registry = yield* registerRegistry(INDEX, null)
    const report = yield* syncRegistry(registry.id)
    for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
    return { registry, report }
  })

const loadRegistry = (id: string) =>
  Effect.flatMap(RegistryRepository, (r) => r.findById(id as never)).pipe(Effect.map(Option.getOrThrow))

describe("theme on sync", () => {
  it.effect("registry.json のスタイルが 1 つなら、エンリッチの前に自動で適用する (ダークが無いのでライトだけ撮る)", () => {
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const captures: Array<RecordedCapture> = []
    const layer = makeInMemoryLayer({ fixtures: fixtures([style("index")]), jobs, renderer: FakePreviewRendererWith({ captures }) })
    return Effect.gen(function* () {
      const { registry, report } = yield* ingest(jobs)
      expect(report.themeAgent).toBe(false)
      const saved = yield* loadRegistry(registry.id)
      expect(saved.theme).toMatchObject({ _tag: "Resolved", source: "registry-item" })
      expect(saved.previewConfig.baseItems).toEqual(["https://acme.dev/r/index.json"])
      expect(saved.previewConfig.tokens?.light["--main"]).toBe("#5294ff")
      // button / card と、スタイル自身の適用例 (style も撮る)
      expect(captures.map((c) => c.schemes)).toEqual([["light"], ["light"], ["light"]])
      // 同じ registry.json で再同期しても判定し直さない
      jobs.enrichments.length = 0
      yield* syncRegistry(registry.id)
      expect(jobs.enrichments).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("運営者が手で決めたテーマは、registry.json が変わっても上書きせず提案に留める", () => {
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const fx = fixtures()
    const layer = makeInMemoryLayer({ fixtures: fx, jobs })
    return Effect.gen(function* () {
      const { registry } = yield* ingest(jobs)
      yield* updateRegistryPreviewConfig(registry.id, { themeCss: ":root{--main:red}" })
      Object.assign(fx, fixtures([style("index")]))
      yield* syncRegistry(registry.id)
      const saved = yield* loadRegistry(registry.id)
      expect(saved.theme._tag).toBe("Proposed")
      expect(saved.previewConfig).toEqual({ themeCss: ":root{--main:red}" })
      yield* rejectThemeProposal(registry.id)
      expect((yield* loadRegistry(registry.id)).theme).toMatchObject({ _tag: "Resolved", source: "none" })
    }).pipe(Effect.provide(layer))
  })
})

describe("theme agent", () => {
  const docs = FakeDocsReader({
    "https://acme.dev": { markdown: "# Acme", links: ["https://acme.dev/docs/installation", "https://acme.dev/blog/hello", "https://other.dev/docs/install"] },
    "https://acme.dev/docs/installation": { markdown: "pnpm dlx shadcn@latest add https://acme.dev/r/styling/blue.json" },
  })
  const output = {
    build: { baseItems: ["https://acme.dev/r/styling/blue.json"], themeVars: { "--color-main": "var(--main)" }, fonts: ["DM Sans"] },
    tokens: { light: { "--main": "#5294ff", "--background": "#dcebfe", "--foreground": "#000000" } },
    evidence: [{ url: "https://acme.dev/docs/installation", quote: "shadcn add https://acme.dev/r/styling/blue.json" }],
    confidence: "high",
    notes: "The installation guide adds the blue styling item.",
  }

  it.effect("テーマ系アイテムが無ければエージェントを回し、その間プレビューを保留し、確信度が十分なら承認なしで適用する", () => {
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const started: Array<ThemeAgentInput> = []
    const demoCalls: Array<string> = []
    const layer = makeInMemoryLayer({
      fixtures: fixtures(),
      jobs,
      config: { themeAgent: true },
      themeAgent: FakeThemeAgent({ output, started }),
      docs,
      demoWriter: FakeDemoWriter({ calls: demoCalls }),
    })
    return Effect.gen(function* () {
      const { registry, report } = yield* ingest(jobs)
      expect(report.themeAgent).toBe(true)
      expect((yield* loadRegistry(registry.id)).theme._tag).toBe("AgentPending")
      const button = ComponentId.make("acme:button")
      const held = Option.getOrThrow(yield* (yield* ComponentRepository).findById(button)).enrichment
      expect(held.preview._tag).toBe("NotCaptured") // 保留中は作らない
      expect(held.doc._tag).toBe("Generated")

      const job = Option.getOrThrow(yield* startThemeAgent(registry.id))
      expect(started[0]!.docs.map((d) => d.url)).toEqual(["https://acme.dev", "https://acme.dev/docs/installation"])
      expect(started[0]!.allowedHosts).toContain("acme.dev")
      const theme = Option.getOrThrow(yield* collectThemeAgent(registry.id, job))
      expect(theme).toMatchObject({ _tag: "Resolved", source: "agent" })
      const saved = yield* loadRegistry(registry.id)
      expect(saved.previewConfig.fonts).toEqual(["DM Sans"])

      // 保留が解け、最初からレジストリのテーマで作る (neutral で作ってから作り直す、をしない)
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      expect(Option.getOrThrow(yield* (yield* ComponentRepository).findById(button)).enrichment.preview._tag).toBe("Captured")
      expect(demoCalls.length).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("確信度が低い提案は適用せず、neutral のまま提案として残す。運営者が承認すればデモを再利用して作り直す", () => {
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const demoCalls: Array<string> = []
    const layer = makeInMemoryLayer({
      fixtures: fixtures(),
      jobs,
      config: { themeAgent: true },
      themeAgent: FakeThemeAgent({ output: { ...output, confidence: "low" } }),
      docs,
      demoWriter: FakeDemoWriter({ calls: demoCalls }),
    })
    return Effect.gen(function* () {
      const { registry } = yield* ingest(jobs)
      const job = Option.getOrThrow(yield* startThemeAgent(registry.id))
      const theme = Option.getOrThrow(yield* collectThemeAgent(registry.id, job))
      expect(theme).toMatchObject({ _tag: "Proposed", proposal: { source: "agent", confidence: "low" } })
      expect((yield* loadRegistry(registry.id)).previewConfig.fonts).toBeUndefined()

      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      const written = demoCalls.length
      const { rebuilding } = yield* approveThemeProposal(registry.id)
      expect(rebuilding).toBe(2)
      const { plan } = yield* enrichComponent(ComponentId.make("acme:button"))
      expect(plan.steps.map((s) => s._tag)).toEqual(["BuildPreview", "CapturePreview", "Index"])
      expect(demoCalls.length).toBe(written) // デモは書き直さない
    }).pipe(Effect.provide(layer))
  })

  it.effect("レジストリ以外のホストを baseItems に入れる提案は採用しない", () => {
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({
      fixtures: fixtures(),
      jobs,
      config: { themeAgent: true },
      themeAgent: FakeThemeAgent({ output: { ...output, build: { baseItems: ["https://evil.dev/r/x.json"] } } }),
      docs,
    })
    return Effect.gen(function* () {
      const { registry } = yield* ingest(jobs)
      const job = Option.getOrThrow(yield* startThemeAgent(registry.id))
      const theme = Option.getOrThrow(yield* collectThemeAgent(registry.id, job))
      expect(theme._tag).toBe("Failed")
      expect(theme._tag === "Failed" && theme.reason).toContain("not hosted by the registry")
    }).pipe(Effect.provide(layer))
  })

  it.effect("長すぎる根拠・メモは切り詰め、型の上限を超える設定は理由付きの失敗にする。セッションは結果を保存してから片付ける", () => {
    const run = (themeOutput: unknown) => {
      const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
      const cancelled: Array<string> = []
      const layer = makeInMemoryLayer({
        fixtures: fixtures(),
        jobs,
        config: { themeAgent: true },
        themeAgent: FakeThemeAgent({ output: themeOutput, cancelled }),
        docs,
      })
      return Effect.gen(function* () {
        const { registry } = yield* ingest(jobs)
        const job = Option.getOrThrow(yield* startThemeAgent(registry.id))
        const theme = Option.getOrThrow(yield* collectThemeAgent(registry.id, job))
        return { theme, cancelled, job }
      }).pipe(Effect.provide(layer))
    }
    return Effect.gen(function* () {
      const long = yield* run({ ...output, evidence: [{ url: "https://acme.dev/docs/installation", quote: "x".repeat(5000) }], notes: "n".repeat(9000) })
      expect(long.theme).toMatchObject({ _tag: "Resolved", source: "agent" })
      expect(long.theme._tag === "Resolved" && long.theme.note.length).toBe(4000)
      expect(long.cancelled).toEqual([long.job.id])

      const fonts = yield* run({ ...output, build: { ...output.build, fonts: ["A", "B", "C", "D", "E"] } })
      expect(fonts.theme._tag).toBe("Failed")
      expect(fonts.theme._tag === "Failed" && fonts.theme.reason).toContain("fonts: at most 4")
      expect(fonts.cancelled).toEqual([fonts.job.id])
    })
  })

  it.effect("手順が見つからなければ neutral のまま確定する", () => {
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({ fixtures: fixtures(), jobs, config: { themeAgent: true }, themeAgent: FakeThemeAgent({ output: null }), docs })
    return Effect.gen(function* () {
      const { registry } = yield* ingest(jobs)
      const job = Option.getOrThrow(yield* startThemeAgent(registry.id))
      expect(Option.getOrThrow(yield* collectThemeAgent(registry.id, job))).toMatchObject({ _tag: "Resolved", source: "none" })
      expect(jobs.enrichments.length).toBeGreaterThan(0) // 保留が解けたプレビューを投入する
    }).pipe(Effect.provide(layer))
  })
})

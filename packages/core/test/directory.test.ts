import { describe, expect, it } from "@effect/vitest"
import { Effect, Either, Option, TestClock } from "effect"
import {
  directoryStatus,
  enrichComponent,
  planComponentEnrichment,
  regenerate,
  intakeDirectory,
  liveSnapshot,
  registerRegistry,
  scheduleResyncAll,
  syncDirectory,
  syncRegistry,
} from "../src/application/index.js"
import { ComponentId, EnrichmentState, Registry, RegistryId, candidateLocators, classifyRegistryInput, sameItemTemplate, type StoredPipelineEvent, UsageRecord, chooseModel, mergeDirectoryEntry, planDirectoryIntake, usd } from "../src/domain/index.js"
import { ComponentRepository, RegistryRepository } from "../src/ports/index.js"
import { type ScheduledJobs, makeInMemoryLayer, testConfig } from "../src/testing/index.js"

const DIRECTORY = "https://ui.shadcn.com/r/registries.json"

const entry = (name: string, host: string, ranking: number, itemCount: number, extra: Record<string, unknown> = {}) => ({
  name: `@${name}`,
  homepage: `https://${host}`,
  url: `https://${host}/r/{name}.json`,
  description: `${name} components`,
  health: { status: "healthy", score: 90, hidden: false },
  ranking: { score: ranking, itemCount },
  ...extra,
})

const index = (name: string, items: number) => ({
  name,
  homepage: `https://${name}.dev`,
  items: Array.from({ length: items }, (_, i) => ({ name: `item-${i}`, type: "registry:ui" })),
})

const items = (host: string, count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      `https://${host}/r/item-${i}.json`,
      { name: `item-${i}`, type: "registry:ui", files: [{ path: `ui/item-${i}.tsx`, type: "registry:ui", content: "export {}" }] },
    ]),
  )

const fixtures = (directory: Array<unknown>): Record<string, unknown> => ({
  [DIRECTORY]: directory,
  "https://alpha.dev/r/registry.json": index("alpha", 2),
  "https://beta.dev/r/registry.json": index("beta", 3),
  "https://gamma.dev/r/registry.json": index("gamma", 1),
  ...items("alpha.dev", 2),
  ...items("beta.dev", 3),
  ...items("gamma.dev", 1),
})

const setup = (directory: Array<unknown>, config: Partial<typeof testConfig> = {}) => {
  const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
  return { jobs, layer: makeInMemoryLayer({ fixtures: fixtures(directory), jobs, config }) }
}

const makeShadcnSetup = () => {
  const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
  const fx = { ...fixtures([]), "https://ui.shadcn.com/r/styles/new-york-v4/registry.json": index("shadcn", 2) }
  return { jobs, layer: makeInMemoryLayer({ fixtures: fx, jobs, config: {} }) }
}

describe("official directory", () => {
  it.effect("手で登録したレジストリがディレクトリに載っていれば Official に直し、取り込み済みにする", () => {
    const { layer } = setup([entry("alpha", "alpha.dev", 50, 2)])
    return Effect.gen(function* () {
      // URL で登録しても、ディレクトリと照合されて Official になる
      const registry = yield* registerRegistry("https://alpha.dev/r/registry.json", null)
      expect(registry.listing).toEqual({ _tag: "Official", directoryName: "@alpha", listed: true })

      const repo = yield* RegistryRepository
      // v0.6 以前の行 (出自なし = 運営者の登録として読む) を模す
      yield* repo.update(new Registry({ ...registry, listing: { _tag: "Community", requestedVia: "operator", reference: null } }))
      const report = yield* syncDirectory
      // ディレクトリに無い shadcn/ui 自身 (@shadcn) は常に足される
      expect(report).toMatchObject({ listed: 2, added: 2, relabeled: 1 })
      const relabeled = Option.getOrThrow(yield* repo.findById(registry.id))
      expect(relabeled.listing._tag).toBe("Official")
      const status = yield* directoryStatus
      expect(status.counts).toMatchObject({ Imported: 1 })
    }).pipe(Effect.provide(layer))
  })

  it.effect("@shadcn は shadcn/ui 自身の new-york-v4 の registry.json に解決され、Official になる", () => {
    const { layer } = makeShadcnSetup()
    return Effect.gen(function* () {
      const registry = yield* registerRegistry("@shadcn", null)
      expect(registry.locator.indexUrl).toBe("https://ui.shadcn.com/r/styles/new-york-v4/registry.json")
      expect(registry.listing).toEqual({ _tag: "Official", directoryName: "@shadcn", listed: true })
    }).pipe(Effect.provide(layer))
  })

  it.effect("ranking の高い順に上限件数だけ取り込み、大きすぎるものは Skipped にする", () => {
    const { layer, jobs } = setup(
      [
        entry("gamma", "gamma.dev", 10, 1),
        entry("alpha", "alpha.dev", 90, 2),
        entry("beta", "beta.dev", 70, 3),
        entry("huge", "huge.dev", 99, 9_000),
      ],
      { lifecycle: { ...testConfig.lifecycle, intakePerRun: 2 } },
    )
    return Effect.gen(function* () {
      yield* syncDirectory
      const first = yield* intakeDirectory
      expect(first.imported).toEqual(["@alpha", "@beta"])
      expect(first.skipped).toEqual(["@huge"])
      expect(jobs.syncs).toEqual(["alpha", "beta"])
      const second = yield* intakeDirectory
      expect(second.imported).toEqual(["@gamma"])
      const status = yield* directoryStatus
      // @shadcn は件数が分からないので自動では取り込まない (運営者が @shadcn で登録する)
      expect(status.counts).toMatchObject({ Imported: 3, Skipped: 2, New: 0 })
      expect(status.entries.find((e) => e.name === "@huge")?.skipReason).toContain("too large")
    }).pipe(Effect.provide(layer))
  })

  it.effect("エンリッチの backlog が上限を超えている間は取り込まない", () => {
    const { layer, jobs } = setup([entry("alpha", "alpha.dev", 90, 2)], {
      lifecycle: { ...testConfig.lifecycle, maxBacklog: 1 },
    })
    return Effect.gen(function* () {
      jobs.enrichments.push(...(["a:1", "a:2"] as never[]))
      yield* syncDirectory
      expect(yield* intakeDirectory).toMatchObject({ deferred: true, imported: [] })
    }).pipe(Effect.provide(layer))
  })

  it.effect("ディレクトリから外れたら Delisted にし、レジストリの Official は listed=false にする", () => {
    let directory: Array<unknown> = [entry("alpha", "alpha.dev", 90, 2)]
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const fx = fixtures(directory)
    const layer = makeInMemoryLayer({ fixtures: fx, jobs })
    return Effect.gen(function* () {
      yield* syncDirectory
      yield* intakeDirectory
      directory = []
      fx[DIRECTORY] = directory
      const report = yield* syncDirectory
      expect(report.delisted).toBe(1)
      const registry = Option.getOrThrow(yield* (yield* RegistryRepository).findById(RegistryId.make("alpha")))
      expect(registry.listing).toMatchObject({ _tag: "Official", listed: false })
    }).pipe(Effect.provide(layer))
  })

  it("planDirectoryIntake: 非表示・失敗の上限・unavailable を除外する", () => {
    const now = 0
    const make = (name: string, extra: Record<string, unknown>) =>
      mergeDirectoryEntry(undefined, entry(name, `${name}.dev`, 50, 10, extra) as never, now)
    const plan = planDirectoryIntake(
      [
        make("hidden", { health: { status: "healthy", hidden: true } }),
        make("down", { health: { status: "unavailable" } }),
        { ...make("flaky", {}), attempts: 3 },
        make("ok", {}),
      ],
      { maxItems: 500, maxAttempts: 3, limit: 10 },
    )
    expect(plan.importNow.map((e) => e.name)).toEqual(["@ok"])
    expect(plan.skip.map((s) => s.entry.name).sort()).toEqual(["@flaky", "@hidden"])
  })
})

describe("weekly resync", () => {
  it.effect("前回の同期から 7 日経ったものだけを、古い順に投入する", () => {
    const { layer, jobs } = setup([entry("alpha", "alpha.dev", 90, 2), entry("beta", "beta.dev", 70, 3)])
    const day = 24 * 3600 * 1000
    return Effect.gen(function* () {
      const alpha = yield* registerRegistry("@alpha", null)
      yield* syncRegistry(alpha.id)
      yield* TestClock.adjust(3 * day)
      const beta = yield* registerRegistry("@beta", null)
      yield* syncRegistry(beta.id)
      jobs.syncs.splice(0)

      yield* TestClock.adjust(5 * day) // alpha: 8 日前、beta: 5 日前
      expect(yield* scheduleResyncAll).toBe(1)
      expect(jobs.syncs).toEqual(["alpha"])
    }).pipe(Effect.provide(layer))
  })
})

describe("LLM routing and the free daily quota", () => {
  const routing = {
    ...testConfig.llm,
    doc: ["gpt-5.6-luna", "gpt-6-luna"],
    demo: ["gpt-5.6-luna"],
    repair: ["gpt-6-luna"],
    quotas: [
      { name: "1m", models: ["gpt-6-luna"], dailyTokens: 1_000_000 },
      { name: "10m", models: ["gpt-5.6-luna"], dailyTokens: 10_000_000 },
    ],
  }

  it("優先順に無料枠が残っているモデルを選び、使い切ったら Pause なら待ち、Paid なら有料で続ける", () => {
    expect(chooseModel(routing.doc, routing, new Map())).toEqual({ _tag: "Use", model: "gpt-5.6-luna", free: true })
    // 10M の 9 割 - 余裕 を超えたら次の候補へ
    const nearly = new Map([["gpt-5.6-luna", 8_990_000]])
    expect(chooseModel(routing.doc, routing, nearly)).toEqual({ _tag: "Use", model: "gpt-6-luna", free: true })
    const both = new Map([["gpt-5.6-luna", 9_000_000], ["gpt-6-luna", 900_000]])
    expect(chooseModel(routing.doc, routing, both)._tag).toBe("Wait")
    expect(chooseModel(routing.doc, { ...routing, overflow: { _tag: "Paid", model: "gpt-6-luna" } }, both)).toEqual({
      _tag: "Use",
      model: "gpt-6-luna",
      free: false,
    })
  })

  it.effect("無料で使った分は 0 円で記録し、使い切ったらエンリッチを翌日に回す", () => {
    const usage: Array<UsageRecord> = []
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({
      fixtures: fixtures([entry("alpha", "alpha.dev", 90, 2)]),
      jobs,
      usage,
      config: { llm: routing },
    })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry("@alpha", null)
      yield* syncRegistry(registry.id)
      const [first, second] = jobs.enrichments.splice(0)
      yield* enrichComponent(first!)
      const llm = usage.filter((u) => u.category === "llm")
      expect(llm.map((u) => u.model)).toEqual(["gpt-5.6-luna", "gpt-5.6-luna"]) // doc + demo
      expect(llm.every((u) => u.amount === 0 && u.detail.free === 1)).toBe(true)

      // 両方の群を使い切った日: ドキュメントが書けないのでコンポーネントごと後回し
      const at = llm[0]!.at
      usage.push(
        new UsageRecord({ category: "llm", amount: usd(0), subject: "x", detail: { inputTokens: 9_000_000, outputTokens: 0 }, at, model: "gpt-5.6-luna" }),
        new UsageRecord({ category: "llm", amount: usd(0), subject: "x", detail: { inputTokens: 900_000, outputTokens: 0 }, at, model: "gpt-6-luna" }),
      )
      const plan = yield* planComponentEnrichment(second!)
      expect(plan.decision._tag).toBe("Defer")
    }).pipe(Effect.provide(layer))
  })
})

describe("regenerate", () => {
  it.effect("ソースが同じでもドキュメントを未生成に戻して投入し、書き直す", () => {
    const usage: Array<UsageRecord> = []
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({ fixtures: fixtures([entry("alpha", "alpha.dev", 90, 2)]), jobs, usage })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry("@alpha", null)
      yield* syncRegistry(registry.id)
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      const before = usage.filter((u) => u.category === "llm").length
      // 変更がなければ何もしない
      const idle = yield* planComponentEnrichment(ComponentId.make("alpha:item-0"))
      expect(idle.steps).toEqual([])

      expect(yield* regenerate({ registryId: registry.id }, "docs")).toEqual({ scheduled: 2 })
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      const docCalls = usage.filter((u) => u.category === "llm").length - before
      expect(docCalls).toBe(2) // ドキュメントだけ (デモは書き直さない)
    }).pipe(Effect.provide(layer))
  })
})

describe("public pipeline log", () => {
  it.effect("同期と生成の流れを、金額や生のエラー無しで順に記録し、/live の要約を組み立てる", () => {
    const events: Array<StoredPipelineEvent> = []
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({ fixtures: fixtures([entry("alpha", "alpha.dev", 90, 2)]), jobs, events })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry("@alpha", null)
      yield* syncRegistry(registry.id)
      const first = jobs.enrichments.splice(0)[0]!
      yield* enrichComponent(first)
      const forComponent = events.filter((e) => e.componentId === first).map((e) => `${e.stage}:${e.status}`)
      expect(forComponent).toEqual(["plan:start", "docs:ok", "demo:ok", "build:ok", "capture:ok", "index:ok"])
      expect(events.filter((e) => e.componentId === null).map((e) => `${e.stage}:${e.status}`)).toEqual(
        expect.arrayContaining(["sync:start", "sync:ok"]),
      )
      expect(events.find((e) => e.stage === "demo")?.detail.code).toBeTypeOf("string")
      expect(JSON.stringify(events)).not.toMatch(/amount|usd|cost/i)

      const live = yield* liveSnapshot()
      expect(live.active).toEqual([]) // インデックスまで終わったので進行中ではない
      expect(live.captured.map((e) => e.componentId)).toEqual([first])
      expect(live.finishedToday).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("embedding reuse", () => {
  it.effect("撮り直しても写っているものが同じなら画像を、ドキュメントが同じならテキストを埋め込み直さない", () => {
    const usage: Array<UsageRecord> = []
    const jobs: ScheduledJobs = { syncs: [], enrichments: [] }
    const layer = makeInMemoryLayer({ fixtures: fixtures([entry("alpha", "alpha.dev", 90, 2)]), jobs, usage })
    return Effect.gen(function* () {
      const registry = yield* registerRegistry("@alpha", null)
      yield* syncRegistry(registry.id)
      const [first] = jobs.enrichments.splice(0)
      yield* enrichComponent(first!)
      const embedded = () => usage.filter((u) => u.category === "embedding").map((u) => u.detail)
      expect(embedded()).toEqual([{ texts: 1, images: 2 }])

      // 撮影方式の版上げ (CAPTURE_VERSION) を模す: 撮り直し → インデックス
      const repo = yield* ComponentRepository
      const record = Option.getOrThrow(yield* repo.findById(first!))
      const p = record.enrichment.preview
      if (p._tag !== "Captured") throw new Error("not captured")
      yield* repo.saveEnrichment(first!, new EnrichmentState({ ...record.enrichment, preview: { ...p, captureVersion: "cap-old" } }))
      const { plan } = yield* enrichComponent(first!)
      expect(plan.steps.map((s) => s._tag)).toEqual(["CapturePreview", "Index"])
      expect(embedded()).toEqual([{ texts: 1, images: 2 }]) // 増えていない

      // 作り直し (プレビュー) はデモから書き直すので、画像は埋め込み直す
      yield* regenerate({ componentId: first! }, "previews")
      for (const id of jobs.enrichments.splice(0)) yield* enrichComponent(id)
      expect(embedded().at(-1)).toEqual({ texts: 1, images: 2 })
    }).pipe(Effect.provide(layer))
  })
})

describe("{style} templates", () => {
  it("{style} 入りのテンプレートはよく使われる style を順に試し、解決後の URL もディレクトリと一致させる", () => {
    const input = Either.getOrThrow(classifyRegistryInput("https://diceui.com/r/{style}/{name}.json"))
    const locators = candidateLocators(input)
    expect(locators.map((l) => l.indexUrl)).toContain("https://diceui.com/r/radix-vega/registry.json")
    expect(sameItemTemplate("https://diceui.com/r/{style}/{name}.json", "https://diceui.com/r/radix-vega/{name}.json")).toBe(true)
    expect(sameItemTemplate("https://diceui.com/r/{style}/{name}.json", "https://other.dev/r/radix-vega/{name}.json")).toBe(false)
  })
})

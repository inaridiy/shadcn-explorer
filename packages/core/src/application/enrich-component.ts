import { Clock, Data, Effect, Option } from "effect"
import {
  type BudgetDecision,
  type ComponentId,
  type ComponentSnapshot,
  EnrichmentState,
  type EnrichmentStep,
  type MicroUsd,
  UsageRecord,
  type UsageDoc,
  decideBudget,
  estimateStepCost,
  installCommand,
  monthStart,
  planEnrichment,
} from "../domain/index.js"
import {
  BlobStore,
  CodingAgent,
  type ColorScheme,
  type ComponentRecord,
  ComponentRepository,
  Embedder,
  ExplorerConfig,
  PreviewRenderer,
  RegistryHttp,
  RegistryRepository,
  TextSearchIndex,
  UsageLedger,
  VisualIndex,
  type VisualVector,
} from "../ports/index.js"

export class ComponentNotFound extends Data.TaggedError("ComponentNotFound")<{
  readonly componentId: ComponentId
}> {}

// ---------------------------------------------------------------------------
// オブジェクトキー (R2)。ハッシュを含めることで古い成果物と混ざらない (= CDN キャッシュも安全)
// ---------------------------------------------------------------------------

const keyBase = (id: ComponentId) => id.replace(":", "/")
export const previewHtmlKey = (id: ComponentId, hash: string) => `previews/${keyBase(id)}/${hash}.html`
export const screenshotKey = (id: ComponentId, hash: string, scheme: ColorScheme) =>
  `screenshots/${keyBase(id)}/${hash}-${scheme}.png`

/** 検索インデックスに入れる Markdown。AI Search のチャンク化を意識して見出しで区切る */
export const toSearchMarkdown = (snapshot: ComponentSnapshot, doc: Option.Option<UsageDoc>): string => {
  const lines = [
    `# ${snapshot.title}`,
    "",
    `registry: ${snapshot.registryId} / name: ${snapshot.name} / kind: ${snapshot.kind}`,
    "",
    snapshot.description,
  ]
  if (snapshot.categories.length > 0) lines.push("", `categories: ${snapshot.categories.join(", ")}`)
  if (snapshot.dependencies.length > 0) lines.push("", `dependencies: ${snapshot.dependencies.join(", ")}`)
  if (Option.isSome(doc)) {
    const d = doc.value
    lines.push("", "## Summary", d.summary, "", "## Appearance", d.visualDescription)
    if (d.whenToUse.length > 0) lines.push("", "## When to use", ...d.whenToUse.map((w) => `- ${w}`))
    if (d.keywords.length > 0) lines.push("", `keywords: ${d.keywords.join(", ")}`)
    if (d.examples.length > 0) lines.push("", "## Examples", ...d.examples.map((e) => `- ${e.title}: ${e.description}`))
  }
  return lines.join("\n")
}

const loadRecord = (id: ComponentId) =>
  Effect.gen(function* () {
    const repo = yield* ComponentRepository
    const found = yield* repo.findById(id)
    if (Option.isNone(found)) return yield* new ComponentNotFound({ componentId: id })
    return found.value
  })

const recordUsage = (record: Omit<ConstructorParameters<typeof UsageRecord>[0], "at">) =>
  Effect.gen(function* () {
    const ledger = yield* UsageLedger
    const at = yield* Clock.currentTimeMillis
    yield* ledger.record(new UsageRecord({ ...record, at }))
  })

const saveState = (id: ComponentId, patch: Partial<EnrichmentState>) =>
  Effect.gen(function* () {
    const repo = yield* ComponentRepository
    const current = yield* loadRecord(id)
    yield* repo.saveEnrichment(id, new EnrichmentState({ ...current.enrichment, ...patch }))
  })

export interface EnrichmentPlan {
  readonly componentId: ComponentId
  readonly steps: ReadonlyArray<EnrichmentStep>
  readonly decision: BudgetDecision
  readonly estimatedCost: MicroUsd
}

/** 実行計画 + 予算判断 */
export const planComponentEnrichment = (id: ComponentId) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const config = yield* ExplorerConfig
    const ledger = yield* UsageLedger
    const now = yield* Clock.currentTimeMillis
    const steps = planEnrichment(record.snapshot, record.enrichment, config.enrichment)
    const spent = yield* ledger.spentSince(monthStart(now))
    const decision = decideBudget(steps, spent, config.budget, config.prices)
    const estimatedCost = steps.reduce((s, st) => s + estimateStepCost(st, config.prices), 0) as MicroUsd
    return { componentId: id, steps, decision, estimatedCost } satisfies EnrichmentPlan
  })

export const allowedSteps = (plan: EnrichmentPlan): ReadonlyArray<EnrichmentStep> => {
  switch (plan.decision._tag) {
    case "Proceed":
      return plan.steps
    case "Degrade":
      return plan.decision.allowed
    case "Defer":
      return []
  }
}

// ---------------------------------------------------------------------------
// 各ステップ。Workflow の step.do 1 つに対応し、それぞれ冪等。
// 失敗はドメイン状態 (Failed + attempts) に記録して成功扱いで返す: 無限リトライで課金されないように。
// ---------------------------------------------------------------------------

export type StepOutcome = Data.TaggedEnum<{
  Done: {}
  Skipped: { readonly reason: string }
  Failed: { readonly error: string }
}>
export const StepOutcome = Data.taggedEnum<StepOutcome>()

const generateDoc = (record: ComponentRecord) =>
  Effect.gen(function* () {
    const agent = yield* CodingAgent
    const http = yield* RegistryHttp
    const repo = yield* ComponentRepository
    const registries = yield* RegistryRepository
    const blobs = yield* BlobStore
    const { prices } = yield* ExplorerConfig
    const { snapshot } = record

    const registry = yield* registries.findById(snapshot.registryId)
    const namespace = Option.getOrNull(Option.flatMap(registry, (r) => Option.fromNullable(r.namespace)))
    const itemJson = yield* http.getJson(snapshot.sourceUrl)

    const result = yield* agent
      .generate({ snapshot, itemJson, installCommand: installCommand(snapshot, namespace) })
      .pipe(Effect.either)
    const now = yield* Clock.currentTimeMillis

    if (result._tag === "Left") {
      const prev = record.enrichment.doc
      const attempts = prev._tag === "Failed" && prev.sourceHash === snapshot.contentHash ? prev.attempts + 1 : 1
      yield* saveState(snapshot.id, {
        doc: { _tag: "Failed", sourceHash: snapshot.contentHash, error: result.left.reason, attempts, failedAt: now },
      })
      return StepOutcome.Failed({ error: result.left.reason })
    }

    const out = result.right
    yield* repo.saveDoc(snapshot.id, out.doc)
    if (Option.isSome(out.previewHtml)) {
      yield* blobs.put(previewHtmlKey(snapshot.id, snapshot.contentHash), out.previewHtml.value, "text/html; charset=utf-8")
    }
    yield* saveState(snapshot.id, {
      doc: { _tag: "Generated", sourceHash: snapshot.contentHash, agentPreset: agent.presetName, generatedAt: now },
    })
    yield* recordUsage({
      category: "agent",
      amount: prices.agentRunEstimate,
      subject: snapshot.id,
      detail: { ...out.usage },
    })
    return StepOutcome.Done()
  })

const capturePreview = (record: ComponentRecord) =>
  Effect.gen(function* () {
    const renderer = yield* PreviewRenderer
    const blobs = yield* BlobStore
    const { prices } = yield* ExplorerConfig
    const { snapshot } = record
    const hash = snapshot.contentHash

    const html = yield* blobs.get(previewHtmlKey(snapshot.id, hash))
    if (Option.isNone(html)) {
      yield* saveState(snapshot.id, { preview: { _tag: "Skipped", reason: "プレビュー HTML が生成されていません" } })
      return StepOutcome.Skipped({ reason: "no preview html" })
    }
    const source = new TextDecoder().decode(html.value)

    const shots = yield* Effect.forEach(
      ["light", "dark"] as const,
      (scheme) =>
        renderer.capture(source, scheme).pipe(
          Effect.tap(({ png }) => blobs.put(screenshotKey(snapshot.id, hash, scheme), png, "image/png")),
          Effect.map(({ durationMs }) => durationMs),
        ),
      { concurrency: 1 },
    ).pipe(Effect.either)
    const now = yield* Clock.currentTimeMillis

    if (shots._tag === "Left") {
      const prev = record.enrichment.preview
      const attempts = prev._tag === "Failed" && prev.sourceHash === hash ? prev.attempts + 1 : 1
      const error = shots.left.reason
      yield* saveState(snapshot.id, { preview: { _tag: "Failed", sourceHash: hash, error, attempts, failedAt: now } })
      return StepOutcome.Failed({ error })
    }

    const seconds = shots.right.reduce((a, b) => a + b, 0) / 1000
    yield* saveState(snapshot.id, {
      preview: {
        _tag: "Captured",
        sourceHash: hash,
        lightKey: screenshotKey(snapshot.id, hash, "light"),
        darkKey: screenshotKey(snapshot.id, hash, "dark"),
        htmlKey: previewHtmlKey(snapshot.id, hash),
        capturedAt: now,
      },
    })
    yield* recordUsage({
      category: "browser",
      amount: Math.round(prices.browserPerSecond * seconds) as MicroUsd,
      subject: snapshot.id,
      detail: { seconds },
    })
    return StepOutcome.Done()
  })

const indexComponent = (record: ComponentRecord, withImage: boolean) =>
  Effect.gen(function* () {
    const textIndex = yield* TextSearchIndex
    const visualIndex = yield* VisualIndex
    const embedder = yield* Embedder
    const blobs = yield* BlobStore
    const { prices } = yield* ExplorerConfig
    const { snapshot, doc, enrichment } = record
    const markdown = toSearchMarkdown(snapshot, doc)

    const base = { componentId: snapshot.id, registryId: snapshot.registryId, kind: snapshot.kind }
    const vectors: Array<VisualVector> = [
      { ...base, modality: "doc", values: yield* embedder.embedDocument(snapshot.title, markdown) },
    ]
    let images = 0
    if (withImage && enrichment.preview._tag === "Captured") {
      const keys = [
        ["light", enrichment.preview.lightKey],
        ["dark", enrichment.preview.darkKey],
      ] as const
      for (const [modality, key] of keys) {
        if (key === null) continue
        const png = yield* blobs.get(key)
        if (Option.isNone(png)) continue
        vectors.push({ ...base, modality, values: yield* embedder.embedImage(png.value) })
        images++
      }
    }

    yield* textIndex.upsert({ ...base, markdown })
    yield* visualIndex.upsert(vectors)
    const now = yield* Clock.currentTimeMillis
    yield* saveState(snapshot.id, {
      index: { _tag: "Indexed", sourceHash: snapshot.contentHash, withImage: images > 0, indexedAt: now },
    })
    yield* recordUsage({
      category: "embedding",
      amount: (prices.textEmbedding + prices.imageEmbedding * images) as MicroUsd,
      subject: snapshot.id,
      detail: { texts: 1, images },
    })
    return StepOutcome.Done()
  })

/** 1 ステップを実行する (Workflow の step.do から呼ばれる) */
export const runEnrichmentStep = (id: ComponentId, step: EnrichmentStep) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    switch (step._tag) {
      case "GenerateDoc":
        return yield* generateDoc(record)
      case "CapturePreview":
        return yield* capturePreview(record)
      case "Index":
        return yield* indexComponent(record, step.withImage)
    }
  }).pipe(Effect.withSpan("runEnrichmentStep", { attributes: { componentId: id, step: step._tag } }))

/** 計画 → 予算判断 → 全ステップ実行 (ローカル実行・テスト用。本番は Workflow が同じ部品を使う) */
export const enrichComponent = (id: ComponentId) =>
  Effect.gen(function* () {
    const plan = yield* planComponentEnrichment(id)
    const outcomes: Array<{ step: EnrichmentStep["_tag"]; outcome: StepOutcome }> = []
    for (const step of allowedSteps(plan)) {
      outcomes.push({ step: step._tag, outcome: yield* runEnrichmentStep(id, step) })
    }
    return { plan, outcomes }
  })

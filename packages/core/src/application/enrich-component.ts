import { Clock, Data, Duration, Effect, Option } from "effect"
import {
  type BudgetDecision,
  type ComponentId,
  type ComponentSnapshot,
  EnrichmentState,
  type EnrichmentStep,
  type MicroUsd,
  type UsageDoc,
  UsageRecord,
  type UserId,
  addMicro,
  decideBudget,
  estimateStepCost,
  installCommand,
  llmCost,
  monthStart,
  nextAttempts,
  planEnrichment,
} from "../domain/index.js"
import {
  BlobStore,
  type ColorScheme,
  type ComponentRecord,
  ComponentRepository,
  type ComponentVector,
  DocWriter,
  Embedder,
  ExplorerConfig,
  JobScheduler,
  type LlmUsage,
  PersistenceError,
  PreviewBuilder,
  type PreviewJob,
  PreviewRenderer,
  RegistryHttp,
  RegistryRepository,
  TextSearchIndex,
  UsageLedger,
  VectorIndex,
} from "../ports/index.js"
import { NotRegistryOwner } from "./errors.js"
import { itemSourceKey, previewHtmlKey, screenshotKey } from "./keys.js"

export class ComponentNotFound extends Data.TaggedError("ComponentNotFound")<{
  readonly componentId: ComponentId
}> {}

/** 検索インデックスに入れる Markdown */
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

const usageDetail = (usage: LlmUsage) => ({
  inputTokens: usage.inputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  outputTokens: usage.outputTokens,
  durationMs: usage.durationMs,
})

const saveState = (id: ComponentId, patch: Partial<EnrichmentState>) =>
  Effect.gen(function* () {
    const repo = yield* ComponentRepository
    const current = yield* loadRecord(id)
    yield* repo.saveEnrichment(id, new EnrichmentState({ ...current.enrichment, ...patch }))
  })

/** registry-item.json 原本。R2 に無ければ (旧データ) ソース URL から取り直して保存する */
const loadItemJson = (snapshot: ComponentSnapshot) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const key = itemSourceKey(snapshot.id, snapshot.contentHash)
    const stored = yield* blobs.get(key)
    if (Option.isSome(stored)) return JSON.parse(new TextDecoder().decode(stored.value)) as unknown
    const http = yield* RegistryHttp
    const fetched = yield* http.getJson(snapshot.sourceUrl)
    yield* blobs.put(key, JSON.stringify(fetched), "application/json")
    return fetched
  })

const namespaceOf = (snapshot: ComponentSnapshot) =>
  Effect.gen(function* () {
    const registries = yield* RegistryRepository
    const registry = yield* registries.findById(snapshot.registryId)
    return Option.getOrNull(Option.flatMap(registry, (r) => Option.fromNullable(r.namespace)))
  })

// ---------------------------------------------------------------------------
// 計画
// ---------------------------------------------------------------------------

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
    const estimatedCost = steps.reduce((s, st) => addMicro(s, estimateStepCost(st, config.prices)), 0 as MicroUsd)
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
// 永続化以外の失敗は全てドメイン状態 (Failed + attempts) に記録して成功扱いで返す:
//   - 1 件の失敗でバッチ全体を止めない
//   - Workflow の自動リトライで無限に課金されない (再試行は attempts と backlog sweeper が管理)
// ---------------------------------------------------------------------------

export type StepOutcome = Data.TaggedEnum<{
  Done: {}
  Skipped: { readonly reason: string }
  Failed: { readonly error: string }
}>
export const StepOutcome = Data.taggedEnum<StepOutcome>()

const describe = (e: { readonly _tag: string } & Partial<Record<"reason" | "message", unknown>>): string =>
  `${e._tag}: ${String(e.reason ?? e.message ?? "")}`.slice(0, 500)

/**
 * 永続化エラーと「コンポーネントが無い」以外の失敗を、指定した記録処理に流す。
 * 永続化エラーは状態を記録すること自体ができないので、呼び出し元 (Workflow) のリトライに任せる。
 */
const recordFailures = <A, E extends { readonly _tag: string }, R, B, R2>(
  effect: Effect.Effect<A, E, R>,
  onFailure: (error: string) => Effect.Effect<B, PersistenceError | ComponentNotFound, R2>,
): Effect.Effect<A | B, PersistenceError | ComponentNotFound, R | R2> =>
  effect.pipe(
    Effect.catchAll(
      (e): Effect.Effect<B, PersistenceError | ComponentNotFound, R2> =>
        e._tag === "PersistenceError" || e._tag === "ComponentNotFound"
          ? Effect.fail(e as unknown as PersistenceError | ComponentNotFound)
          : onFailure(describe(e as never)),
    ),
  )

const generateDoc = (record: ComponentRecord) => {
  const { snapshot } = record
  const hash = snapshot.contentHash
  return recordFailures(
    Effect.gen(function* () {
      const writer = yield* DocWriter
      const repo = yield* ComponentRepository
      const { prices } = yield* ExplorerConfig
      const itemJson = yield* loadItemJson(snapshot)
      const namespace = yield* namespaceOf(snapshot)
      const out = yield* writer
        .write({ snapshot, itemJson, installCommand: installCommand(snapshot, namespace) })
        .pipe(
          // 失敗した呼び出しも課金され得るので、見積もり額で台帳に積んでおく
          Effect.tapError(() =>
            recordUsage({
              category: "llm",
              amount: llmCost(prices.docTokensEstimate, prices.docModel),
              subject: snapshot.id,
              registryId: snapshot.registryId,
              detail: { failed: 1 },
            }).pipe(Effect.ignore),
          ),
        )
      const now = yield* Clock.currentTimeMillis
      yield* repo.saveDoc(snapshot.id, out.doc)
      yield* saveState(snapshot.id, {
        doc: { _tag: "Generated", sourceHash: hash, agentPreset: writer.model, generatedAt: now },
      })
      yield* recordUsage({
        category: "llm",
        amount: llmCost(out.usage, prices.docModel),
        subject: snapshot.id,
        registryId: snapshot.registryId,
        detail: usageDetail(out.usage),
      })
      return StepOutcome.Done()
    }),
    (error) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* saveState(snapshot.id, {
          doc: { _tag: "Failed", sourceHash: hash, error, attempts: nextAttempts(record.enrichment.doc, hash), failedAt: now },
        })
        return StepOutcome.Failed({ error })
      }),
  )
}

// --- プレビュービルド (2 段階: start → poll)

const failPreview = (record: ComponentRecord, stage: "build" | "capture", error: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const hash = record.snapshot.contentHash
    yield* saveState(record.snapshot.id, {
      preview: {
        _tag: "Failed",
        sourceHash: hash,
        stage,
        error,
        attempts: nextAttempts(record.enrichment.preview, hash),
        failedAt: now,
      },
    })
    return StepOutcome.Failed({ error })
  })

/** プレビュービルドを開始する。失敗は状態に記録して None を返す */
export const startPreviewBuild = (id: ComponentId) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const { snapshot } = record
    const result = yield* Effect.either(
      Effect.gen(function* () {
        const builder = yield* PreviewBuilder
        const itemJson = yield* loadItemJson(snapshot)
        const namespace = yield* namespaceOf(snapshot)
        return yield* builder.start({
          snapshot,
          itemJson,
          installCommand: installCommand(snapshot, namespace),
          doc: record.doc,
        })
      }),
    )
    if (result._tag === "Right") return Option.some(result.right)
    if (result.left._tag === "PersistenceError") return yield* result.left
    yield* failPreview(record, "build", describe(result.left as never))
    return Option.none<PreviewJob>()
  })

/**
 * ビルドの完了を確認する。
 * - Running: None (呼び出し側がしばらく待って再度呼ぶ)
 * - Done: HTML を R2 に保存して Built に遷移、コストを記録
 */
export const collectPreviewBuild = (id: ComponentId, job: PreviewJob) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const { snapshot } = record
    const hash = snapshot.contentHash
    return yield* recordFailures(
      Effect.gen(function* () {
        const builder = yield* PreviewBuilder
        const blobs = yield* BlobStore
        const { prices } = yield* ExplorerConfig
        const polled = yield* builder.poll(job)
        if (polled._tag === "Running") return Option.none<StepOutcome>()

        yield* recordUsage({
          category: "agent",
          amount: addMicro(llmCost(polled.usage, prices.previewModel), prices.previewSandboxEstimate),
          subject: snapshot.id,
          registryId: snapshot.registryId,
          detail: usageDetail(polled.usage),
        })
        const now = yield* Clock.currentTimeMillis
        if (Option.isNone(polled.html)) {
          yield* saveState(snapshot.id, {
            preview: { _tag: "Skipped", reason: "ビルダーがプレビュー不要と判断しました", sourceHash: hash },
          })
          return Option.some(StepOutcome.Skipped({ reason: "no preview" }))
        }
        yield* blobs.put(previewHtmlKey(snapshot.id, hash), polled.html.value, "text/html; charset=utf-8")
        yield* saveState(snapshot.id, { preview: { _tag: "Built", sourceHash: hash, builtAt: now } })
        return Option.some(StepOutcome.Done())
      }),
      (error) => Effect.map(failPreview(record, "build", error), Option.some),
    )
  })

/** 打ち切り (タイムアウト)。セッションを片付けて失敗として記録する */
export const abandonPreviewBuild = (id: ComponentId, job: PreviewJob, reason: string) =>
  Effect.gen(function* () {
    const builder = yield* PreviewBuilder
    yield* builder.cancel(job)
    const record = yield* loadRecord(id)
    return yield* failPreview(record, "build", reason)
  })

/** start → poll をその場で回す版 (ローカル実行・テスト用。本番の Workflow は step.sleep で待つ) */
const buildPreviewInline = (id: ComponentId) =>
  Effect.gen(function* () {
    const { previewBuild } = yield* ExplorerConfig
    const job = yield* startPreviewBuild(id)
    if (Option.isNone(job)) return StepOutcome.Failed({ error: "preview build could not start" })
    const deadline = (yield* Clock.currentTimeMillis) + previewBuild.timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const outcome = yield* collectPreviewBuild(id, job.value)
      if (Option.isSome(outcome)) return outcome.value
      yield* Effect.sleep(Duration.millis(previewBuild.pollIntervalMs))
    }
    return yield* abandonPreviewBuild(id, job.value, "preview build timed out")
  })

const capturePreview = (record: ComponentRecord) => {
  const { snapshot } = record
  const hash = snapshot.contentHash
  return recordFailures(
    Effect.gen(function* () {
      const renderer = yield* PreviewRenderer
      const blobs = yield* BlobStore
      const { prices } = yield* ExplorerConfig
      const current = record.enrichment.preview
      // 同じ実行内でビルドが失敗・スキップ済みなら撮影もしない (失敗回数を二重に数えない)
      if ((current._tag === "Failed" && current.stage === "build") || current._tag === "Skipped") {
        return StepOutcome.Skipped({ reason: "preview was not built" })
      }
      const html = yield* blobs.get(previewHtmlKey(snapshot.id, hash))
      if (Option.isNone(html)) {
        // HTML が無いのはビルド側の問題なので build 段階の失敗として記録する (次回ビルドからやり直し)
        return yield* failPreview(record, "build", "preview html is missing")
      }
      const { shots, durationMs } = yield* renderer.capture(new TextDecoder().decode(html.value), ["light", "dark"])
      yield* Effect.forEach(shots, ({ scheme, png }) => blobs.put(screenshotKey(snapshot.id, hash, scheme), png, "image/png"), {
        concurrency: 2,
        discard: true,
      })
      const now = yield* Clock.currentTimeMillis
      const has = (scheme: ColorScheme) => shots.some((s) => s.scheme === scheme)
      yield* saveState(snapshot.id, {
        preview: {
          _tag: "Captured",
          sourceHash: hash,
          lightKey: screenshotKey(snapshot.id, hash, "light"),
          darkKey: has("dark") ? screenshotKey(snapshot.id, hash, "dark") : null,
          htmlKey: previewHtmlKey(snapshot.id, hash),
          capturedAt: now,
        },
      })
      yield* recordUsage({
        category: "browser",
        amount: Math.round(prices.browserPerSecond * (durationMs / 1000)) as MicroUsd,
        subject: snapshot.id,
        registryId: snapshot.registryId,
        detail: { seconds: durationMs / 1000 },
      })
      return StepOutcome.Done()
    }),
    (error) => failPreview(record, "capture", error),
  )
}

const indexComponent = (record: ComponentRecord, withImage: boolean) => {
  const { snapshot, doc, enrichment } = record
  const hash = snapshot.contentHash
  return recordFailures(
    Effect.gen(function* () {
      const textIndex = yield* TextSearchIndex
      const vectorIndex = yield* VectorIndex
      const embedder = yield* Embedder
      const blobs = yield* BlobStore
      const { prices } = yield* ExplorerConfig
      const markdown = toSearchMarkdown(snapshot, doc)

      const base = { componentId: snapshot.id, registryId: snapshot.registryId, kind: snapshot.kind }
      const vectors: Array<ComponentVector> = [
        { ...base, modality: "doc", values: yield* embedder.embedDocument(snapshot.title, markdown) },
      ]
      let images = 0
      if (withImage && enrichment.preview._tag === "Captured") {
        for (const [modality, key] of [
          ["light", enrichment.preview.lightKey],
          ["dark", enrichment.preview.darkKey],
        ] as const) {
          if (key === null) continue
          const png = yield* blobs.get(key)
          if (Option.isNone(png)) continue
          vectors.push({ ...base, modality, values: yield* embedder.embedImage(png.value) })
          images++
        }
      }

      yield* textIndex.upsert({ ...base, markdown })
      yield* vectorIndex.upsert(vectors)
      const now = yield* Clock.currentTimeMillis
      yield* saveState(snapshot.id, {
        index: { _tag: "Indexed", sourceHash: hash, withImage: images > 0, indexedAt: now },
      })
      yield* recordUsage({
        category: "embedding",
        amount: (prices.textEmbedding + prices.imageEmbedding * images) as MicroUsd,
        subject: snapshot.id,
        registryId: snapshot.registryId,
        detail: { texts: 1, images },
      })
      return StepOutcome.Done()
    }),
    (error) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* saveState(snapshot.id, {
          index: { _tag: "Failed", sourceHash: hash, error, attempts: nextAttempts(enrichment.index, hash), failedAt: now },
        })
        return StepOutcome.Failed({ error })
      }),
  )
}

/** 1 ステップを実行する (Workflow の step.do から呼ばれる。BuildPreview はその場で待つ版) */
export const runEnrichmentStep = (id: ComponentId, step: EnrichmentStep) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    switch (step._tag) {
      case "GenerateDoc":
        return yield* generateDoc(record)
      case "BuildPreview":
        return yield* buildPreviewInline(id)
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

/**
 * 手動のエンリッチ要求 (ドキュメント再生成など)。登録者のみ。
 * 失敗回数の上限で止まっているものも、明示的な要求ならリセットして再試行する。
 */
export const requestEnrichment = (id: ComponentId, requester: UserId) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const registries = yield* RegistryRepository
    const repo = yield* ComponentRepository
    const scheduler = yield* JobScheduler
    const registry = yield* registries.findById(record.snapshot.registryId)
    const ownerId = Option.getOrNull(Option.flatMap(registry, (r) => Option.fromNullable(r.ownerId)))
    if (ownerId !== null && ownerId !== requester) {
      return yield* new NotRegistryOwner({ registryId: record.snapshot.registryId })
    }
    const { doc, preview, index } = record.enrichment
    yield* repo.saveEnrichment(
      id,
      new EnrichmentState({
        doc: doc._tag === "Failed" ? { _tag: "NotGenerated" } : doc,
        preview: preview._tag === "Failed" || preview._tag === "Skipped" ? { _tag: "NotCaptured" } : preview,
        index: index._tag === "Failed" ? { _tag: "NotIndexed" } : index,
      }),
    )
    yield* scheduler.scheduleEnrichment([id])
  })

/**
 * Backlog sweeper (cron)。ソースが変わっていなくても未完了のもの
 * (予算で後回しにされた・一時障害で失敗した・プレビュービルダーが後から設定された) を拾い直す。
 * 予算上限に達していれば何もしない。
 */
export const scheduleBacklog = (options: { readonly pageSize?: number; readonly maxItems?: number } = {}) =>
  Effect.gen(function* () {
    const repo = yield* ComponentRepository
    const scheduler = yield* JobScheduler
    const ledger = yield* UsageLedger
    const config = yield* ExplorerConfig
    const now = yield* Clock.currentTimeMillis
    const spent = yield* ledger.spentSince(monthStart(now))
    if (spent >= config.budget.monthlyLimit) return { scanned: 0, scheduled: 0 }

    const pageSize = options.pageSize ?? 200
    const maxItems = options.maxItems ?? 2000
    const pending: Array<ComponentId> = []
    let scanned = 0
    for (let offset = 0; pending.length < maxItems; offset += pageSize) {
      const page = yield* repo.list({ limit: pageSize, offset })
      scanned += page.length
      for (const record of page) {
        if (planEnrichment(record.snapshot, record.enrichment, config.enrichment).length > 0) pending.push(record.snapshot.id)
      }
      if (page.length < pageSize) break
    }
    const ids = pending.slice(0, maxItems)
    if (ids.length > 0) yield* scheduler.scheduleEnrichment(ids)
    return { scanned, scheduled: ids.length }
  })

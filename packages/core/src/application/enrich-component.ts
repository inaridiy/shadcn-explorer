import { Clock, type Context, Data, Duration, Effect, Option, Schema } from "effect"
import {
  BudgetDecision,
  oneLine,
  stableHash,
  type RegistryId,
  chooseModel,
  isExpensiveStep,
  type TokenRates,
  type TokenUsage,
  utcDayStart,
  type ComponentId,
  type ComponentSnapshot,
  EnrichmentState,
  type EnrichmentStep,
  type MicroUsd,
  type UsageDoc,
  UsageRecord,
  type UserId,
  BuildManifest,
  type PreviewFailureCause,
  addMicro,
  decideBudget,
  demoLayoutOf,
  estimateStepCost,
  installCommand,
  itemImportPaths,
  lintDemo,
  llmCost,
  monthStart,
  nextAttempts,
  type RegistryPreviewConfig,
  type RegistryPreviewContext,
  emptyPreviewContext,
  isLightOnly,
  planEnrichment,
  previewContextOf,
  previewSourceHash,
  validateManifest,
} from "../domain/index.js"
import {
  AgentError,
  type AgentRunOutcome,
  AgentRunLedger,
  BlobStore,
  type ColorScheme,
  type ComponentRecord,
  ComponentRepository,
  type ComponentVector,
  DemoWriter,
  type DemoWriterInput,
  DocWriter,
  Embedder,
  ExplorerConfig,
  JobScheduler,
  type LlmUsage,
  PersistenceError,
  PreviewAgent,
  type PreviewAgentJob,
  PreviewCompiler,
  PreviewRenderer,
  RegistryHttp,
  RegistryRepository,
  TextSearchIndex,
  UsageLedger,
  VectorIndex,
} from "../ports/index.js"
import { emit } from "./pipeline-log.js"
import {
  captureVariant,
  demoKey,
  embedImageKey,
  itemSourceKey,
  manifestKey,
  motionKey,
  previewHtmlKey,
  screenshotKey,
} from "./keys.js"

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

/** ステップのモデルを無料枠に応じて選ぶ (その日の使用量は台帳から) */
const routeModel = (step: "doc" | "demo" | "repair") =>
  Effect.gen(function* () {
    const { llm } = yield* ExplorerConfig
    const now = yield* Clock.currentTimeMillis
    const used = yield* (yield* UsageLedger).tokensByModelSince(utcDayStart(now))
    return chooseModel(llm[step], llm, used)
  })

/** 実際に呼ぶモデル。計画の後に枠を使い切った (Wait) 場合も、計画で許した呼び出しは優先のモデルで続ける */
const modelFor = (step: "doc" | "demo" | "repair") =>
  Effect.gen(function* () {
    const { llm } = yield* ExplorerConfig
    const choice = yield* routeModel(step)
    return choice._tag === "Use" ? choice : { _tag: "Use" as const, model: llm[step][0]!, free: false }
  })

/** LLM の利用の記録。無料枠で使った分は 0 円 (トークン数は日次の集計のために残す) */
const llmUsageRecord = (
  snapshot: ComponentSnapshot,
  choice: { readonly model: string; readonly free: boolean },
  usage: LlmUsage | null,
  fallbackRates: TokenRates,
  estimate: TokenUsage,
  extra: Record<string, number> = {},
) =>
  Effect.gen(function* () {
    const { llm } = yield* ExplorerConfig
    const rates = llm.rates[choice.model] ?? fallbackRates
    yield* recordUsage({
      category: "llm",
      // 失敗した呼び出しも課金され得るので見積もり額で積む
      amount: choice.free ? (0 as MicroUsd) : llmCost(usage ?? estimate, rates),
      subject: snapshot.id,
      registryId: snapshot.registryId,
      model: choice.model,
      detail: {
        ...(usage ? usageDetail(usage) : { failed: 1, inputTokens: estimate.inputTokens, outputTokens: estimate.outputTokens }),
        ...(choice.free ? { free: 1 } : {}),
        ...extra,
      },
    })
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

/** プレビューの計画に要るレジストリの情報 (設定のハッシュ・テーマを調べている間の保留) */
const previewContextFor = (snapshot: ComponentSnapshot) =>
  Effect.gen(function* () {
    const registry = yield* (yield* RegistryRepository).findById(snapshot.registryId)
    const now = yield* Clock.currentTimeMillis
    return Option.match(registry, { onNone: () => emptyPreviewContext, onSome: (r) => previewContextOf(r, now) })
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
    const steps = planEnrichment(record.snapshot, record.enrichment, config.enrichment, yield* previewContextFor(record.snapshot))
    const spent = yield* ledger.spentSince(monthStart(now))
    const decision = yield* withLlmQuota(steps, decideBudget(steps, spent, config.budget, config.prices))
    const estimatedCost = steps.reduce((s, st) => addMicro(s, estimateStepCost(st, config.prices)), 0 as MicroUsd)
    return { componentId: id, steps, decision, estimatedCost } satisfies EnrichmentPlan
  })

/**
 * 無料枠を使い切っていて (overflow = Pause) LLM のステップが今日は動かせないなら後回しにする。
 * ドキュメントが待つならコンポーネントごと待つ (インデックスもドキュメントの後)。デモだけ待つならプレビューだけ後回し。
 * どちらも次の UTC 日以降に backlog sweeper が拾い直す
 */
const withLlmQuota = (steps: ReadonlyArray<EnrichmentStep>, decision: BudgetDecision) =>
  Effect.gen(function* () {
    const allowed = decision._tag === "Proceed" ? steps : decision._tag === "Degrade" ? decision.allowed : []
    const needsDoc = allowed.some((s) => s._tag === "GenerateDoc")
    const needsDemo = allowed.some((s) => s._tag === "BuildPreview")
    if (!needsDoc && !needsDemo) return decision
    if (needsDoc) {
      const doc = yield* routeModel("doc")
      if (doc._tag === "Wait") return BudgetDecision.Defer({ reason: doc.reason })
    }
    if (needsDemo) {
      const demo = yield* routeModel("demo")
      if (demo._tag === "Wait") {
        const deferred = allowed.filter(isExpensiveStep)
        const rest = allowed.filter((s) => !isExpensiveStep(s))
        return rest.length === 0
          ? BudgetDecision.Defer({ reason: demo.reason })
          : BudgetDecision.Degrade({ allowed: rest, deferred: [...(decision._tag === "Degrade" ? decision.deferred : []), ...deferred] })
      }
    }
    return decision
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
      const choice = yield* modelFor("doc")
      const record = (usage: LlmUsage | null) => llmUsageRecord(snapshot, choice, usage, prices.docModel, prices.docTokensEstimate)
      const out = yield* writer
        .write({ model: choice.model, snapshot, itemJson, installCommand: installCommand(snapshot, namespace) })
        // 失敗した呼び出しも課金され得るので、見積もり額で台帳に積んでおく
        .pipe(Effect.tapError(() => record(null).pipe(Effect.ignore)))
      const now = yield* Clock.currentTimeMillis
      yield* repo.saveDoc(snapshot.id, out.doc)
      yield* saveState(snapshot.id, {
        doc: { _tag: "Generated", sourceHash: hash, agentPreset: presetOf(writer.model, choice.model), generatedAt: now },
      })
      yield* record(out.usage)
      yield* emit({
        registryId: snapshot.registryId,
        componentId: snapshot.id,
        stage: "docs",
        status: "ok",
        message: `Docs written · ${out.doc.props.length} props · ${out.doc.examples.length} examples · ${out.doc.keywords.length} keywords`,
        detail: { durationMs: out.usage.durationMs, model: choice.model },
      })
      return StepOutcome.Done()
    }),
    (error) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* saveState(snapshot.id, {
          doc: { _tag: "Failed", sourceHash: hash, error, attempts: nextAttempts(record.enrichment.doc, hash), failedAt: now },
        })
        // LLM の生のエラーは公開しない
        yield* emit({ registryId: snapshot.registryId, componentId: snapshot.id, stage: "docs", status: "warn", message: "Docs could not be written this time (will retry)" })
        return StepOutcome.Failed({ error })
      }),
  )
}

// --- プレビュー
//   GenerateDemo (LLM) → Compile (コンテナ) ⇄ Repair (LLM, 最大 maxRepairs 回)
//     └ 失敗 (registry / demo / harness) → フォールバックの Coding Agent がビルド手順 (manifest) を書く → Compile
//   → Capture (静止画 + 動く部品は animated WebP)
//
// Workflow ではそれぞれ別の step.do にする (コンテナの一時障害で LLM 呼び出しを払い直さない)。
// デモのソースは試行ごとに R2 に置き、ステップ間では試行番号だけを受け渡す。

/** エージェントが書いたデモの試行番号 (決まった手順の試行 0..maxRepairs と区別する) */
const AGENT_ATTEMPT = 100

const buildHashOf = (snapshot: ComponentSnapshot) =>
  Effect.map(ExplorerConfig, ({ enrichment }) => previewSourceHash(snapshot.contentHash, enrichment.buildVersion))

/**
 * プレビューの失敗を記録する。試行回数は最新の状態から数え、エージェントを試した印 (escalated) は引き継ぐ。
 * 永続化以外の想定外の失敗 (LLM・コンテナ・ブラウザ・R2) は infra。
 */
const failPreview = (
  record: ComponentRecord,
  stage: "build" | "capture",
  error: string,
  cause: PreviewFailureCause,
  options: { readonly escalated?: boolean } = {},
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const hash = yield* buildHashOf(record.snapshot)
    const current = (yield* loadRecord(record.snapshot.id)).enrichment.preview
    const wasEscalated = current._tag === "Failed" && current.sourceHash === hash && current.escalated === true
    const context = yield* previewContextFor(record.snapshot)
    // ビルドできていたデモは覚えておく (テーマの変更で入らなくなった場合も、次はデモを書き直さずにビルドする)
    const demoKeyOf = current._tag === "Failed" || current._tag === "Built" || current._tag === "Captured" ? current.demoKey : undefined
    yield* saveState(record.snapshot.id, {
      preview: {
        _tag: "Failed",
        sourceHash: hash,
        stage,
        error: error.slice(0, 4000),
        cause,
        escalated: options.escalated ?? wasEscalated,
        attempts: nextAttempts(current, hash),
        configHash: context.configHash,
        // デモが悪い (demo) と分かった場合は覚えない (次は書き直す)
        ...(cause !== "demo" && demoKeyOf && demoKeyOf.includes(`/${hash}-`) ? { demoKey: demoKeyOf } : {}),
        failedAt: now,
      },
    })
    return StepOutcome.Failed({ error })
  })

const infraFailure = (record: ComponentRecord, stage: "build" | "capture") => (error: string) =>
  failPreview(record, stage, error, "infra")

const demoInput = (record: ComponentRecord) =>
  Effect.gen(function* () {
    const { snapshot } = record
    const itemJson = yield* loadItemJson(snapshot)
    const namespace = yield* namespaceOf(snapshot)
    return {
      snapshot,
      itemJson,
      installCommand: installCommand(snapshot, namespace),
      doc: record.doc,
      layout: demoLayoutOf(snapshot.kind),
    } satisfies DemoWriterInput
  })

/** "openai:gpt-6-luna" の形 (アダプタの既定の接頭辞に、実際に使ったモデルを付ける) */
const presetOf = (writerModel: string, model: string) => `${writerModel.includes(":") ? writerModel.split(":")[0] : "openai"}:${model}`

const writeDemoCall = (
  record: ComponentRecord,
  call: (writer: Context.Tag.Service<DemoWriter>, input: DemoWriterInput) => Effect.Effect<{ code: string; usage: LlmUsage }, AgentError>,
  attempt: number,
) =>
  Effect.gen(function* () {
    const writer = yield* DemoWriter
    const blobs = yield* BlobStore
    const { prices } = yield* ExplorerConfig
    const { snapshot } = record
    // 試行 0 はデモを書く、それ以降は修正 (修正は強いモデルに回せる)
    const choice = yield* modelFor(attempt === 0 ? "demo" : "repair")
    const usage = (u: LlmUsage | null) =>
      llmUsageRecord(snapshot, choice, u, prices.previewModel, prices.previewTokensEstimate, attempt === 0 ? { demo: 1 } : { demo: 1, repair: attempt })
    const input = { ...(yield* demoInput(record)), model: choice.model }
    const stage = attempt === 0 ? ("demo" as const) : ("repair" as const)
    const out = yield* call(writer, input).pipe(
      Effect.tapError(() =>
        Effect.zip(
          usage(null).pipe(Effect.ignore),
          emit({ registryId: snapshot.registryId, componentId: snapshot.id, stage, status: "warn", message: `The ${stage === "demo" ? "demo" : "fix"} could not be written (model error)` }),
        ),
      ),
    )
    yield* usage(out.usage)
    yield* emit({
      registryId: snapshot.registryId,
      componentId: snapshot.id,
      stage,
      status: "ok",
      message: attempt === 0 ? `Demo written · ${out.code.split("\n").length} lines` : `Fix ${attempt} written`,
      // デモのコードはコンポーネントのページでも公開している
      detail: { attempt, code: out.code.slice(0, 8000), durationMs: out.usage.durationMs, model: choice.model },
    })
    yield* blobs.put(demoKey(snapshot.id, yield* buildHashOf(snapshot), attempt), out.code, "text/plain; charset=utf-8")
    return attempt
  })

/** 試行 0 のデモを書く。失敗は状態に記録して None */
export const generateDemo = (id: ComponentId) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const reused = yield* reusableDemo(record)
    if (Option.isSome(reused)) return reused
    return yield* recordFailures(
      Effect.map(
        writeDemoCall(record, (w, input) => w.write(input), 0),
        (attempt) => Option.some(attempt),
      ),
      (error) => Effect.as(infraFailure(record, "build")(error), Option.none<number>()),
    )
  })

/**
 * 同じソース・ビルド方式で既にビルドできたデモがあれば、その試行番号。
 * レジストリの設定 (テーマ) の変更でビルドし直すときに、LLM でデモを書き直さないため。
 */
const reusableDemo = (record: ComponentRecord) =>
  Effect.gen(function* () {
    const p = record.enrichment.preview
    const key = p._tag === "Built" || p._tag === "Captured" || p._tag === "Failed" ? p.demoKey : undefined
    if (key === undefined) return Option.none<number>()
    const hash = yield* buildHashOf(record.snapshot)
    // demoKey(id, hash, attempt) = ".../{hash}-{attempt}.tsx"。同じソース・ビルド方式のものだけ使う
    const prefix = demoKey(record.snapshot.id, hash, 0).replace(/0\.tsx$/, "")
    const attempt = key.startsWith(prefix) ? Number(key.slice(prefix.length).replace(/\.tsx$/, "")) : Number.NaN
    if (!Number.isInteger(attempt)) return Option.none<number>()
    const stored = yield* (yield* BlobStore).get(key)
    return Option.isSome(stored) ? Option.some(attempt) : Option.none<number>()
  })

/**
 * 前回のデモと問題点から直したデモ (attempt + 1) を書く。
 * 失敗したとき、前の試行で既にビルドできていればそれを残す (Built のまま)。
 */
export const repairDemo = (id: ComponentId, attempt: number, problems: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const blobs = yield* BlobStore
    const hash = yield* buildHashOf(record.snapshot)
    return yield* recordFailures(
      Effect.gen(function* () {
        const previous = yield* blobs.get(demoKey(id, hash, attempt))
        if (Option.isNone(previous)) return yield* new AgentError({ reason: "previous demo is missing", retryable: false })
        const code = new TextDecoder().decode(previous.value)
        return Option.some(yield* writeDemoCall(record, (w, input) => w.repair(input, code, problems), attempt + 1))
      }),
      (error) =>
        record.enrichment.preview._tag === "Built" && record.enrichment.preview.sourceHash === hash
          ? Effect.succeed(Option.none<number>())
          : Effect.as(infraFailure(record, "build")(error), Option.none<number>()),
    )
  })

/** registryDependencies を解決するための components.json の registries (既知の全レジストリ) */
const knownRegistries = Effect.gen(function* () {
  const registries = yield* RegistryRepository
  const all = yield* registries.list()
  return Object.fromEntries(
    all.flatMap((r) => (r.namespace ? [[r.namespace, r.locator.itemUrlTemplate] as const] : [])),
  ) as Record<string, string>
})

/** 保存済みのビルド手順 (エージェントが書いたもの)。ソースのハッシュに紐づくので BUILD_VERSION を上げても使い回す */
const storedManifest = (snapshot: ComponentSnapshot) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const stored = yield* blobs.get(manifestKey(snapshot.id, snapshot.contentHash))
    if (Option.isNone(stored)) return null
    return Option.getOrNull(
      Schema.decodeUnknownOption(Schema.parseJson(BuildManifest))(new TextDecoder().decode(stored.value)),
    )
  })

const compileContext = (snapshot: ComponentSnapshot) =>
  Effect.gen(function* () {
    const registries = yield* RegistryRepository
    const registry = yield* registries.findById(snapshot.registryId)
    return {
      itemJson: yield* loadItemJson(snapshot),
      namespace: yield* namespaceOf(snapshot),
      registries: yield* knownRegistries,
      registryConfig: Option.match(registry, { onNone: () => ({}), onSome: (r) => r.previewConfig }),
    }
  })

/** コンテナを使った時間を台帳に積む */
const recordSandbox = (snapshot: ComponentSnapshot, durationMs: number, detail: Record<string, number>) =>
  Effect.gen(function* () {
    const { prices } = yield* ExplorerConfig
    yield* recordUsage({
      category: "sandbox",
      amount: Math.round(prices.sandboxPerSecond * (durationMs / 1000)) as MicroUsd,
      subject: snapshot.id,
      registryId: snapshot.registryId,
      detail: { seconds: durationMs / 1000, ...detail },
    })
  })

/**
 * コンパイルの結果 (Workflow のステップ間で受け渡すのでプレーンな値)。
 * - Done:   ビルドでき、直すべき問題も無い (または修正回数を使い切ったので今ある HTML で確定)
 * - Repair: デモを直せば良くなる見込みがある。problems を LLM に渡す
 * - Failed: 状態に Failed を記録済み (原因付き。エージェントへの委譲はこれを見て決める)
 */
export type CompileOutcome =
  | { readonly _tag: "Done" }
  | { readonly _tag: "Repair"; readonly problems: ReadonlyArray<string> }
  | { readonly _tag: "Failed"; readonly error: string; readonly cause: PreviewFailureCause }

/**
 * 試行 `attempt` のデモを lint → コンテナでビルドする。
 * ビルドできた HTML は型エラーが残っていても保存して Built にしておく (修正に失敗しても一番良い版が残る)。
 */
export const compileDemo = (id: ComponentId, attempt: number) =>
  Effect.tap(compileDemoOnce(id, attempt), (outcome) =>
    Effect.gen(function* () {
      const record = yield* loadRecord(id)
      const base = { registryId: record.snapshot.registryId, componentId: id, stage: "build" as const }
      const preview = record.enrichment.preview
      switch (outcome._tag) {
        case "Done": {
          const workarounds = preview._tag === "Built" || preview._tag === "Captured" ? (preview.workarounds ?? []).length : 0
          return yield* emit({
            ...base,
            status: "ok",
            message: workarounds > 0 ? `Built · ${workarounds} workaround${workarounds > 1 ? "s" : ""}` : "Built with plain shadcn add",
            detail: { attempt },
          })
        }
        case "Repair":
          return yield* emit({ ...base, status: "warn", message: `Build error: ${oneLine(outcome.problems[0] ?? "")}`, detail: { attempt, problems: outcome.problems.length } })
        case "Failed":
          return yield* emit({
            ...base,
            status: "error",
            message:
              outcome.cause === "registry"
                ? `Cannot be built as published: ${oneLine(outcome.error)}`
                : outcome.cause === "infra"
                  ? "Build failed on our side (will retry)"
                  : `Build failed: ${oneLine(outcome.error)}`,
            detail: { attempt, cause: outcome.cause },
          })
      }
    }).pipe(Effect.ignore),
  )

const compileDemoOnce = (id: ComponentId, attempt: number) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const { snapshot } = record
    const { previewBuild } = yield* ExplorerConfig
    const hash = yield* buildHashOf(snapshot)
    const canRepair = attempt < previewBuild.maxRepairs
    const registryContext = yield* previewContextFor(snapshot)
    const preview = record.enrichment.preview
    const alreadyBuilt =
      preview._tag === "Built" &&
      preview.sourceHash === hash &&
      (preview.configHash ?? registryContext.configHash) === registryContext.configHash
    const giveUp = (error: string, cause: PreviewFailureCause) =>
      alreadyBuilt
        ? Effect.succeed<CompileOutcome>({ _tag: "Done" })
        : Effect.as(failPreview(record, "build", error, cause), { _tag: "Failed", error, cause } as CompileOutcome)

    return yield* recordFailures(
      Effect.gen(function* () {
        const blobs = yield* BlobStore
        const compiler = yield* PreviewCompiler
        const stored = yield* blobs.get(demoKey(id, hash, attempt))
        if (Option.isNone(stored)) return yield* giveUp("demo source is missing", "infra")
        const code = new TextDecoder().decode(stored.value)

        const context = yield* compileContext(snapshot)
        const lint = lintDemo(code, itemImportPaths(context.itemJson))
        if (lint.length > 0) return canRepair ? ({ _tag: "Repair", problems: lint } as const) : yield* giveUp(`lint: ${lint.join(" ")}`, "demo")

        const manifest = yield* storedManifest(snapshot)
        const result = yield* compiler.compile({ snapshot, ...context, manifest, demo: { code, layout: demoLayoutOf(snapshot.kind) } })
        yield* recordSandbox(snapshot, result.durationMs, { attempt })

        if (result._tag === "Rejected") {
          const error = `${result.stage}: ${result.errors.join("\n")}`
          // デモを直して良くなるのは demo 起因のビルドエラーだけ。registry / harness はエージェントか人の仕事
          if (result.cause === "demo" && result.stage === "build" && canRepair) {
            return { _tag: "Repair", problems: result.errors } as const
          }
          return yield* giveUp(error, result.cause)
        }

        const now = yield* Clock.currentTimeMillis
        yield* blobs.put(previewHtmlKey(id, hash), result.html, "text/html; charset=utf-8")
        yield* saveState(id, {
          preview: {
            _tag: "Built",
            sourceHash: hash,
            demoKey: demoKey(id, hash, attempt),
            buildKind: manifest ? "agent" : "core",
            workarounds: result.workarounds,
            ...(manifest ? { manifestKey: manifestKey(id, snapshot.contentHash) } : {}),
            configHash: registryContext.configHash,
            runtimeTokens: true,
            builtAt: now,
          },
        })
        if (result.diagnostics.length > 0 && canRepair) return { _tag: "Repair", problems: result.diagnostics } as const
        return { _tag: "Done" } as const
      }),
      (error) => giveUp(error, "infra"),
    )
  })

// --- フォールバックの Coding Agent

/**
 * エージェントに回すか。原因が registry / demo / harness の build 失敗で、このソース・版でまだ試しておらず、
 * レジストリ単位の上限・遮断機・月次予算の内側のときだけ。
 */
const escalationBlocker = (record: ComponentRecord) =>
  Effect.gen(function* () {
    const { previewBuild } = yield* ExplorerConfig
    const agent = previewBuild.agent
    if (agent === null) return Option.some("agent disabled")
    const hash = yield* buildHashOf(record.snapshot)
    const p = record.enrichment.preview
    if (p._tag !== "Failed" || p.sourceHash !== hash) return Option.some("not failed")
    if (p.escalated) return Option.some("already escalated")
    if (p.cause === undefined || p.cause === "infra") return Option.some("infra failures are retried, not escalated")

    const { enrichment } = yield* ExplorerConfig
    const runs = yield* AgentRunLedger
    const stats = yield* runs.stats(record.snapshot.registryId, enrichment.buildVersion)
    const counts = yield* (yield* ComponentRepository).countByRegistry()
    const items = counts.get(record.snapshot.registryId) ?? 0
    const cap = Math.min(agent.maxPerRegistry, Math.max(1, Math.ceil(items * agent.maxRatio)))
    if (stats.runs >= cap) return Option.some(`registry cap reached (${stats.runs}/${cap})`)
    if (stats.runs >= agent.breakerMinRuns && stats.succeeded / stats.runs < agent.breakerMinSuccessRate) {
      return Option.some(`circuit breaker: ${stats.succeeded}/${stats.runs} agent builds succeeded for this registry`)
    }
    const now = yield* Clock.currentTimeMillis
    const spent = yield* (yield* UsageLedger).spentSince(monthStart(now), "agent")
    if (spent >= agent.monthlyBudget) return Option.some("monthly agent budget reached")
    return Option.none<string>()
  })

const recordAgentRun = (
  record: ComponentRecord,
  outcome: AgentRunOutcome,
  detail: string,
  workarounds: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const { enrichment } = yield* ExplorerConfig
    const at = yield* Clock.currentTimeMillis
    yield* (yield* AgentRunLedger).record({
      componentId: record.snapshot.id,
      registryId: record.snapshot.registryId,
      buildVersion: enrichment.buildVersion,
      outcome,
      workarounds,
      detail: detail.slice(0, 2000),
      at,
    })
  })

/** 最後に試したデモ (エージェントへの入力) */
const latestDemo = (record: ComponentRecord) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const { previewBuild } = yield* ExplorerConfig
    const hash = yield* buildHashOf(record.snapshot)
    for (let attempt = previewBuild.maxRepairs; attempt >= 0; attempt--) {
      const stored = yield* blobs.get(demoKey(record.snapshot.id, hash, attempt))
      if (Option.isSome(stored)) return new TextDecoder().decode(stored.value)
    }
    return ""
  })

/**
 * エージェントを起動する。回さない場合・起動に失敗した場合は None (理由はログ)。
 * 起動したら escalated を立てる (Workflow のリトライや次の実行で二重に払わない)。
 */
export const startPreviewAgent = (id: ComponentId) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const blocker = yield* escalationBlocker(record)
    if (Option.isSome(blocker)) {
      yield* Effect.logInfo("preview agent not started", { componentId: id, reason: blocker.value })
      return Option.none<PreviewAgentJob>()
    }
    const p = record.enrichment.preview
    if (p._tag !== "Failed") return Option.none<PreviewAgentJob>()
    const started = yield* Effect.either(
      Effect.gen(function* () {
        const agent = yield* PreviewAgent
        const context = yield* compileContext(record.snapshot)
        return yield* agent.start({
          snapshot: record.snapshot,
          ...context,
          layout: demoLayoutOf(record.snapshot.kind),
          lastDemo: yield* latestDemo(record),
          errors: [p.error],
          cause: p.cause ?? "infra",
        })
      }),
    )
    if (started._tag === "Left") {
      if (started.left._tag === "PersistenceError") return yield* started.left
      yield* Effect.logWarning("preview agent failed to start", { componentId: id, error: describe(started.left as never) })
      return Option.none<PreviewAgentJob>()
    }
    yield* saveState(id, { preview: { ...p, escalated: true } })
    yield* emit({
      registryId: record.snapshot.registryId,
      componentId: id,
      stage: "agent",
      status: "start",
      message: "Handed to a coding agent to write a build recipe",
    })
    return Option.some(started.right)
  })

/**
 * エージェントの完了を確認する。Running なら None。
 * 完了したら手順 (demo.tsx + manifest) を検証し、こちらのコンテナで決定的にビルドする。
 */
export const collectPreviewAgent = (id: ComponentId, job: PreviewAgentJob) =>
  Effect.tap(collectPreviewAgentOnce(id, job), (outcome) =>
    Option.isNone(outcome)
      ? Effect.void
      : Effect.flatMap(loadRecord(id), (record) =>
          emit({
            registryId: record.snapshot.registryId,
            componentId: id,
            stage: "agent",
            status: outcome.value._tag === "Done" ? "ok" : "error",
            message: outcome.value._tag === "Done" ? "The agent's recipe built" : "The agent could not build it either",
          }),
        ).pipe(Effect.ignore),
  )

const collectPreviewAgentOnce = (id: ComponentId, job: PreviewAgentJob) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const { snapshot } = record
    const hash = yield* buildHashOf(snapshot)
    const agentFailure = (outcome: AgentRunOutcome, error: string, cause: PreviewFailureCause) =>
      Effect.gen(function* () {
        yield* recordAgentRun(record, outcome, error)
        return yield* failPreview(record, "build", `agent ${outcome}: ${error}`, cause, { escalated: true })
      })
    return yield* recordFailures(
      Effect.gen(function* () {
        const agent = yield* PreviewAgent
        const polled = yield* agent.poll(job)
        if (polled._tag === "Running") return Option.none<StepOutcome>()

        const { prices } = yield* ExplorerConfig
        yield* recordUsage({
          category: "agent",
          amount: llmCost(polled.usage, prices.previewModel),
          subject: snapshot.id,
          registryId: snapshot.registryId,
          detail: usageDetail(polled.usage),
        })
        const previous = record.enrichment.preview
        const cause = previous._tag === "Failed" ? (previous.cause ?? "demo") : "demo"
        if (polled.result._tag === "GaveUp") return Option.some(yield* agentFailure("gave_up", polled.result.reason, cause))

        const { demo, manifest: rawManifest } = polled.result
        const manifest = Schema.decodeUnknownOption(BuildManifest)(rawManifest)
        const context = yield* compileContext(snapshot)
        const problems = Option.match(manifest, {
          onNone: () => ["manifest does not match the schema"],
          onSome: (m) => [...validateManifest(m), ...lintDemo(demo, itemImportPaths(context.itemJson))],
        })
        if (Option.isNone(manifest) || problems.length > 0) {
          return Option.some(yield* agentFailure("rejected", problems.join("; "), cause))
        }

        const compiler = yield* PreviewCompiler
        const blobs = yield* BlobStore
        const result = yield* compiler.compile({
          snapshot,
          ...context,
          manifest: manifest.value,
          demo: { code: demo, layout: demoLayoutOf(snapshot.kind) },
        })
        yield* recordSandbox(snapshot, result.durationMs, { agent: 1 })
        if (result._tag === "Rejected") {
          return Option.some(yield* agentFailure("failed", `${result.stage}: ${result.errors.join("\n")}`, result.cause))
        }
        const now = yield* Clock.currentTimeMillis
        yield* blobs.put(demoKey(id, hash, AGENT_ATTEMPT), demo, "text/plain; charset=utf-8")
        yield* blobs.put(manifestKey(id, snapshot.contentHash), JSON.stringify(manifest.value), "application/json")
        yield* blobs.put(previewHtmlKey(id, hash), result.html, "text/html; charset=utf-8")
        yield* saveState(id, {
          preview: {
            _tag: "Built",
            sourceHash: hash,
            demoKey: demoKey(id, hash, AGENT_ATTEMPT),
            buildKind: "agent",
            workarounds: result.workarounds,
            manifestKey: manifestKey(id, snapshot.contentHash),
            configHash: (yield* previewContextFor(snapshot)).configHash,
            runtimeTokens: true,
            builtAt: now,
          },
        })
        yield* recordAgentRun(record, "succeeded", "", result.workarounds)
        return Option.some(StepOutcome.Done())
      }),
      // エージェント側の基盤の失敗 (environment_setup_failed など) はエージェントを試したことにしない (後で再委譲できる)
      (error) => Effect.map(failPreview(record, "build", error, "infra", { escalated: false }), Option.some),
    )
  })

/** 打ち切り (タイムアウト)。セッションを片付けて記録する */
export const abandonPreviewAgent = (id: ComponentId, job: PreviewAgentJob, reason: string) =>
  Effect.gen(function* () {
    yield* (yield* PreviewAgent).cancel(job)
    const record = yield* loadRecord(id)
    yield* recordAgentRun(record, "timed_out", reason)
    const p = record.enrichment.preview
    return yield* failPreview(record, "build", `agent timed_out: ${reason}`, p._tag === "Failed" ? (p.cause ?? "demo") : "demo", {
      escalated: true,
    })
  })

/** エージェントをその場で回す版 (ローカル実行・テスト用。本番の Workflow は step.sleep で待つ) */
const escalateInline = (id: ComponentId) =>
  Effect.gen(function* () {
    const { previewBuild } = yield* ExplorerConfig
    const job = yield* startPreviewAgent(id)
    if (Option.isNone(job) || previewBuild.agent === null) return Option.none<StepOutcome>()
    const deadline = (yield* Clock.currentTimeMillis) + previewBuild.agent.timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const outcome = yield* collectPreviewAgent(id, job.value)
      if (Option.isSome(outcome)) return outcome
      yield* Effect.sleep(Duration.millis(previewBuild.agent.pollIntervalMs))
    }
    return Option.some(yield* abandonPreviewAgent(id, job.value, "timed out"))
  })

/** GenerateDemo → Compile ⇄ Repair (→ エージェント) をその場で回す版 (ローカル実行・テスト用) */
const buildPreviewInline = (id: ComponentId) =>
  Effect.gen(function* () {
    const core = yield* Effect.gen(function* () {
      const first = yield* generateDemo(id)
      if (Option.isNone(first)) return StepOutcome.Failed({ error: "demo generation failed" })
      let attempt = first.value
      for (;;) {
        const outcome = yield* compileDemo(id, attempt)
        if (outcome._tag === "Done") return StepOutcome.Done()
        if (outcome._tag === "Failed") return StepOutcome.Failed({ error: outcome.error })
        const next = yield* repairDemo(id, attempt, outcome.problems)
        if (Option.isNone(next)) {
          const record = yield* loadRecord(id)
          return record.enrichment.preview._tag === "Built" ? StepOutcome.Done() : StepOutcome.Failed({ error: "demo repair failed" })
        }
        attempt = next.value
      }
    })
    if (core._tag !== "Failed") return core
    return Option.getOrElse(yield* escalateInline(id), () => core)
  })

// --- 撮影

/**
 * 静止画 (light / dark) を撮り、動き続ける部品だけ animated WebP も作る。
 * 描画時に例外を出すデモは壊れているので、スクショを残さず build 段階の失敗 (demo) にする (エージェントの対象になる)。
 */
const capturePreview = (record: ComponentRecord) => {
  const { snapshot } = record
  return recordFailures(
    Effect.gen(function* () {
      const renderer = yield* PreviewRenderer
      const blobs = yield* BlobStore
      const { prices, enrichment } = yield* ExplorerConfig
      const hash = yield* buildHashOf(snapshot)
      const captureVersion = enrichment.captureVersion
      // BuildPreview の後に状態が進んでいるので読み直す
      const current = (yield* loadRecord(snapshot.id)).enrichment.preview
      // 同じ実行内でビルドが失敗・スキップ済みなら撮影もしない (失敗回数を二重に数えない)
      if ((current._tag === "Failed" && current.stage === "build") || current._tag === "Skipped") {
        return StepOutcome.Skipped({ reason: "preview was not built" })
      }
      const html = yield* blobs.get(previewHtmlKey(snapshot.id, hash))
      if (Option.isNone(html)) return yield* failPreview(record, "build", "preview html is missing", "infra")

      const layout = demoLayoutOf(snapshot.kind)
      const registry = yield* (yield* RegistryRepository).findById(snapshot.registryId)
      const config: RegistryPreviewConfig = Option.match(registry, { onNone: () => ({}), onSome: (r) => r.previewConfig })
      const context = yield* previewContextFor(snapshot)
      const variant = captureVariant(context)
      // ダークを持たないテーマはライトだけ撮る (neutral のダークとレジストリの色が混ざった画面になるため)
      const schemes: ReadonlyArray<ColorScheme> = isLightOnly(config.tokens) ? ["light"] : ["light", "dark"]
      const captured = yield* renderer.capture(
        new TextDecoder().decode(html.value),
        schemes,
        layout,
        config.tokens ? { tokens: config.tokens } : {},
      )
      yield* recordSandbox(snapshot, captured.durationMs, { capture: 1 })
      if (captured.runtimeErrors.length > 0) {
        return yield* failPreview(record, "build", `runtime error: ${captured.runtimeErrors.join(" | ")}`, "demo")
      }
      yield* Effect.forEach(
        captured.shots,
        ({ scheme, webp, jpeg }) =>
          Effect.all(
            [
              blobs.put(screenshotKey(snapshot.id, hash, captureVersion, scheme, variant), webp, "image/webp"),
              blobs.put(embedImageKey(snapshot.id, hash, captureVersion, scheme, variant), jpeg, "image/jpeg"),
            ],
            { concurrency: 2, discard: true },
          ),
        { concurrency: 2, discard: true },
      )
      const motion = captured.motion ? yield* saveMotion(snapshot, hash, captureVersion, variant, captured.motion) : null

      const now = yield* Clock.currentTimeMillis
      const has = (scheme: ColorScheme) => captured.shots.some((s) => s.scheme === scheme)
      const build =
        current._tag === "Built" || current._tag === "Captured"
          ? {
              ...(current.demoKey ? { demoKey: current.demoKey } : {}),
              ...(current.buildKind ? { buildKind: current.buildKind } : {}),
              ...(current.workarounds ? { workarounds: current.workarounds } : {}),
              ...(current.manifestKey ? { manifestKey: current.manifestKey } : {}),
              ...(current.configHash ? { configHash: current.configHash } : {}),
              ...(current.runtimeTokens ? { runtimeTokens: current.runtimeTokens } : {}),
            }
          : {}
      yield* saveState(snapshot.id, {
        preview: {
          _tag: "Captured",
          sourceHash: hash,
          lightKey: screenshotKey(snapshot.id, hash, captureVersion, "light", variant),
          darkKey: has("dark") ? screenshotKey(snapshot.id, hash, captureVersion, "dark", variant) : null,
          htmlKey: previewHtmlKey(snapshot.id, hash),
          ...build,
          captureVersion,
          ...(motion ? { motion } : {}),
          embedImages: {
            lightKey: embedImageKey(snapshot.id, hash, captureVersion, "light", variant),
            darkKey: has("dark") ? embedImageKey(snapshot.id, hash, captureVersion, "dark", variant) : null,
          },
          tokensHash: context.tokensHash,
          capturedAt: now,
        },
      })
      return StepOutcome.Done()
    }),
    infraFailure(record, "capture"),
  )
}

/** 動くサムネイル (animated WebP) を保存する */
const saveMotion = (
  snapshot: ComponentSnapshot,
  hash: string,
  captureVersion: string,
  variant: string,
  motion: ReadonlyArray<{ readonly scheme: ColorScheme; readonly webp: Uint8Array; readonly durationMs: number }>,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const keys: Partial<Record<ColorScheme, string>> = {}
    for (const { scheme, webp } of motion) {
      const key = motionKey(snapshot.id, hash, captureVersion, scheme, variant)
      yield* blobs.put(key, webp, "image/webp")
      keys[scheme] = key
    }
    if (!keys.light) return null
    return { lightKey: keys.light, darkKey: keys.dark ?? null, durationMs: motion[0]?.durationMs ?? 0 }
  })

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
      const preview = enrichment.preview
      const previous = enrichment.index._tag === "Indexed" ? enrichment.index : null

      // 入力が前回と同じなら埋め込み直さない (ベクトルは Vectorize に残っている)
      const textHash = stableHash(`${snapshot.title}\n${markdown}`)
      const imageHash =
        withImage && preview._tag === "Captured"
          ? stableHash(
              `${preview.sourceHash}|${preview.configHash ?? ""}|${preview.tokensHash ?? ""}|${preview.demoKey ?? ""}|${preview.manifestKey ?? ""}`,
            )
          : undefined
      const reuseText = previous?.textHash === textHash
      const reuseImages = imageHash !== undefined && previous?.withImage === true && previous.imageHash === imageHash

      const base = { componentId: snapshot.id, registryId: snapshot.registryId, kind: snapshot.kind }
      const vectors: Array<ComponentVector> = []
      if (!reuseText) vectors.push({ ...base, modality: "doc", values: yield* embedder.embedDocument(snapshot.title, markdown) })
      let images = 0
      if (withImage && preview._tag === "Captured" && !reuseImages) {
        // 静止画が PNG だった頃のものは embedImages が無く、静止画をそのまま埋め込める
        const source = preview.embedImages ?? preview
        for (const [modality, key] of [
          ["light", source.lightKey],
          ["dark", source.darkKey],
        ] as const) {
          if (key === null) continue
          const image = yield* blobs.get(key)
          if (Option.isNone(image)) continue
          vectors.push({ ...base, modality, values: yield* embedder.embedImage(image.value) })
          images++
        }
      }

      yield* textIndex.upsert({ ...base, markdown })
      if (vectors.length > 0) yield* vectorIndex.upsert(vectors)
      const now = yield* Clock.currentTimeMillis
      const hasImages = reuseImages || images > 0
      yield* saveState(snapshot.id, {
        index: {
          _tag: "Indexed",
          sourceHash: hash,
          withImage: hasImages,
          indexedAt: now,
          textHash,
          ...(hasImages && imageHash ? { imageHash } : {}),
        },
      })
      const texts = reuseText ? 0 : 1
      if (texts + images > 0) {
        yield* recordUsage({
          category: "embedding",
          amount: ((reuseText ? 0 : prices.textEmbedding) + prices.imageEmbedding * images) as MicroUsd,
          subject: snapshot.id,
          registryId: snapshot.registryId,
          detail: { texts, images },
        })
      }
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

/** 撮影の結果を公開ログに出す。撮れたらスクショのキーを載せる (画面がその場でスクショを出す) */
const announceCapture = (id: ComponentId, outcome: StepOutcome) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const base = { registryId: record.snapshot.registryId, componentId: id, stage: "capture" as const }
    const preview = record.enrichment.preview
    if (outcome._tag === "Done" && preview._tag === "Captured") {
      return yield* emit({
        ...base,
        status: "ok",
        message: `Captured ${preview.darkKey ? "light + dark" : "light"}${preview.motion ? " · moving, recorded" : ""}`,
        detail: {
          lightKey: preview.lightKey,
          ...(preview.darkKey ? { darkKey: preview.darkKey } : {}),
          ...(preview.motion ? { motionKey: preview.motion.lightKey } : {}),
        },
      })
    }
    if (outcome._tag === "Failed") {
      return yield* emit({ ...base, status: "error", message: `Capture failed: ${oneLine(outcome.error)}` })
    }
  }).pipe(Effect.ignore)

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
        return yield* Effect.tap(capturePreview(record), (outcome) => announceCapture(id, outcome))
      case "Index":
        return yield* Effect.tap(indexComponent(record, step.withImage), (outcome) =>
          outcome._tag === "Done"
            ? emit({
                registryId: record.snapshot.registryId,
                componentId: id,
                stage: "index",
                status: "ok",
                message: step.withImage ? "Searchable · text and screenshots indexed" : "Searchable · text indexed",
              })
            : outcome._tag === "Failed"
              ? emit({ registryId: record.snapshot.registryId, componentId: id, stage: "index", status: "warn", message: "Indexing failed (will retry)" })
              : Effect.void,
        )
    }
  }).pipe(Effect.withSpan("runEnrichmentStep", { attributes: { componentId: id, step: step._tag } }))

const STEP_LABEL: Record<EnrichmentStep["_tag"], string> = {
  GenerateDoc: "docs",
  BuildPreview: "demo → build",
  CapturePreview: "capture",
  Index: "index",
}

/**
 * 計画を公開ログに出す (Workflow の計画ステップから呼ぶ。キューの消費者の事前の計画では呼ばない)。
 * やることが無い計画は出さない (backlog sweeper が毎日全件を計画し直すので、出すとログが埋まる)
 */
export const announcePlan = (plan: EnrichmentPlan, registryId: RegistryId) => {
  const allowed = allowedSteps(plan)
  // 予算・無料枠で丸ごと後回しになった計画も出さない (枠が切れた瞬間に、キューに残った全件が 1 行ずつ出てしまう)
  if (plan.steps.length === 0 || allowed.length === 0) return Effect.void
  return emit({
    registryId,
    componentId: plan.componentId,
    stage: "plan",
    status: "start",
    message: `Started: ${allowed.map((s) => STEP_LABEL[s._tag]).join(" → ")}`,
    detail: plan.decision._tag === "Degrade" ? { deferred: plan.decision.deferred.length } : {},
  })
}

/** 計画 → 予算判断 → 全ステップ実行 (ローカル実行・テスト用。本番は Workflow が同じ部品を使う) */
export const enrichComponent = (id: ComponentId) =>
  Effect.gen(function* () {
    const plan = yield* planComponentEnrichment(id)
    yield* announcePlan(plan, (yield* loadRecord(id)).snapshot.registryId)
    const outcomes: Array<{ step: EnrichmentStep["_tag"]; outcome: StepOutcome }> = []
    for (const step of allowedSteps(plan)) {
      outcomes.push({ step: step._tag, outcome: yield* runEnrichmentStep(id, step) })
    }
    return { plan, outcomes }
  })

/**
 * 手動のエンリッチ要求 (ドキュメント再生成など)。誰に許すか (現在は運営者のみ) は呼び出し側が決める。
 * 失敗回数の上限で止まっているものも、明示的な要求ならリセットして再試行する。
 */
export const requestEnrichment = (id: ComponentId) =>
  Effect.gen(function* () {
    const record = yield* loadRecord(id)
    const repo = yield* ComponentRepository
    const scheduler = yield* JobScheduler
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
    const contexts = new Map<string, RegistryPreviewContext>(
      (yield* (yield* RegistryRepository).list()).map((r) => [r.id, previewContextOf(r, now)] as const),
    )
    const pending: Array<ComponentId> = []
    let scanned = 0
    for (let offset = 0; pending.length < maxItems; offset += pageSize) {
      const page = yield* repo.list({ limit: pageSize, offset })
      scanned += page.length
      for (const record of page) {
        const context = contexts.get(record.snapshot.registryId) ?? emptyPreviewContext
        if (planEnrichment(record.snapshot, record.enrichment, config.enrichment, context).length > 0) pending.push(record.snapshot.id)
      }
      if (page.length < pageSize) break
    }
    const ids = pending.slice(0, maxItems)
    if (ids.length > 0) yield* scheduler.scheduleEnrichment(ids)
    return { scanned, scheduled: ids.length }
  })

export type RegenerateScope = "docs" | "previews" | "all"
export type RegenerateTarget = { readonly componentId: ComponentId } | { readonly registryId: RegistryId }

/**
 * 運営者の「作り直す」(v0.7)。ソースが変わっていなくても、指定した生成物を未生成に戻して投入する。
 * - docs: ドキュメントを書き直し、インデックスもし直す
 * - previews: デモを書き直してビルド・撮影し直す (同じソースのデモを再利用しない)
 * - all: 両方
 * 失敗の回数も消える (Failed も未生成に戻る) ので、諦めたものの再挑戦にも使える
 */
export const regenerate = (target: RegenerateTarget, scope: RegenerateScope) =>
  Effect.gen(function* () {
    const repo = yield* ComponentRepository
    const records =
      "componentId" in target
        ? [yield* loadRecord(target.componentId)]
        : yield* repo.list({ registryId: target.registryId, limit: 1000, offset: 0 })
    const docs = scope === "docs" || scope === "all"
    const previews = scope === "previews" || scope === "all"
    for (const record of records) {
      const { doc, preview, index } = record.enrichment
      yield* repo.saveEnrichment(
        record.snapshot.id,
        new EnrichmentState({
          doc: docs ? { _tag: "NotGenerated" } : doc,
          preview: previews ? { _tag: "NotCaptured" } : preview,
          // ドキュメントもスクショも検索の入力なので、どちらかを作り直したらインデックスもし直す
          index: { _tag: "NotIndexed" },
        }),
      )
    }
    const ids = records.map((r) => r.snapshot.id)
    if (ids.length > 0) yield* (yield* JobScheduler).scheduleEnrichment(ids)
    return { scheduled: ids.length }
  })

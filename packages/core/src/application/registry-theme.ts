import { describeTheme, emit } from "./pipeline-log.js"
import { Clock, Data, Effect, Option, Schema } from "effect"
import {
  type ComponentId,
  EnrichmentState,
  Registry,
  type RegistryId,
  type RegistryPreviewConfig,
  type RegistryTheme,
  type ThemeCandidate,
  type ThemeConfig,
  ThemeConfidence,
  ThemeTokens,
  ThemeVariant,
  TokenMap,
  ThemeProposal,
  UsageRecord,
  buildConfigHash,
  demoLayoutOf,
  detectThemeFromItems,
  llmCost,
  monthStart,
  previewabilityOf,
  tokensHash,
  validateThemeConfig,
} from "../domain/index.js"
import {
  BlobStore,
  ComponentRepository,
  DocsReader,
  ExplorerConfig,
  JobScheduler,
  type PreviewAgentJob,
  RegistryRepository,
  ThemeAgent,
  type ThemeAgentInput,
  UsageLedger,
} from "../ports/index.js"
import { RegistryNotFoundById } from "./errors.js"
import { itemSourceKey } from "./keys.js"

/**
 * レジストリのテーマ (v0.6)。domain/theme.ts の状態遷移を実行する。
 *   同期 → detectThemeFromItems → 決まれば適用 (Resolved) / 承認待ち (Proposed) / エージェント (AgentPending)
 *   エージェント (SyncRegistryWorkflow の後続ステップ) → 検証 → Proposed → 運営者の承認で適用
 * 設定の変更はどれも applyPreviewConfig を通す: 旧設定で作ったプレビューに旧ハッシュを記録してから設定を替え、
 * そのレジストリのビジュアルなアイテムを投入する。何を作り直すか (ビルドか撮影だけか) は planEnrichment が決める。
 */

export class ThemeProposalNotFound extends Data.TaggedError("ThemeProposalNotFound")<{
  readonly registryId: RegistryId
}> {}

export class InvalidThemeConfig extends Data.TaggedError("InvalidThemeConfig")<{
  readonly problems: ReadonlyArray<string>
}> {}

const THEME_KEYS = ["baseItems", "themeVars", "fonts", "css", "tokens", "variants"] as const

/** テーマの部分を差し替える (手書きの themeCss と pins は残す) */
export const withThemeConfig = (config: RegistryPreviewConfig, theme: ThemeConfig): RegistryPreviewConfig => {
  const rest: Record<string, unknown> = { ...config }
  for (const key of THEME_KEYS) delete rest[key]
  return { ...(rest as RegistryPreviewConfig), ...theme }
}

const loadRegistry = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const found = yield* (yield* RegistryRepository).findById(registryId)
    if (Option.isNone(found)) return yield* new RegistryNotFoundById({ registryId })
    return found.value
  })

/** そのレジストリのビジュアルなアイテム (プレビューを作るもの) */
const visualComponents = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const components = yield* ComponentRepository
    const out = []
    for (let offset = 0; ; offset += 200) {
      const page = yield* components.list({ registryId, limit: 200, offset })
      out.push(...page.filter((r) => previewabilityOf(r.snapshot.kind)._tag !== "NonVisual"))
      if (page.length < 200) break
    }
    return out
  })

/** プレビューの保留が解けた・設定が変わったときに、そのレジストリのビジュアルなアイテムを投入する (計画が空なら何もしない) */
export const schedulePreviews = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const ids: Array<ComponentId> = (yield* visualComponents(registryId)).map((r) => r.snapshot.id)
    if (ids.length > 0) yield* (yield* JobScheduler).scheduleEnrichment(ids)
    return ids.length
  })

/**
 * レジストリの設定とテーマの状態を保存する。ビルド設定・トークンが変わるなら:
 * 1. ハッシュを持たない (v0.5 以前の) プレビューに旧設定のハッシュを記録する (= 旧設定で作ったと明示し、作り直しの対象にする)
 * 2. 設定を保存し、ビジュアルなアイテムを投入する
 */
export const applyPreviewConfig = (registry: Registry, config: RegistryPreviewConfig, theme: RegistryTheme = registry.theme) =>
  Effect.gen(function* () {
    const registries = yield* RegistryRepository
    const components = yield* ComponentRepository
    const before = { config: buildConfigHash(registry.previewConfig), tokens: tokensHash(registry.previewConfig) }
    const after = { config: buildConfigHash(config), tokens: tokensHash(config) }
    const changed = before.config !== after.config || before.tokens !== after.tokens
    if (changed) {
      for (const record of yield* visualComponents(registry.id)) {
        const p = record.enrichment.preview
        if (p._tag !== "Built" && p._tag !== "Captured") continue
        const stampConfig = p.configHash === undefined
        const stampTokens = p._tag === "Captured" && p.tokensHash === undefined
        if (!stampConfig && !stampTokens) continue
        yield* components.saveEnrichment(
          record.snapshot.id,
          new EnrichmentState({
            ...record.enrichment,
            preview: {
              ...p,
              ...(stampConfig ? { configHash: before.config } : {}),
              ...(stampTokens ? { tokensHash: before.tokens } : {}),
            },
          }),
        )
      }
    }
    const updated = new Registry({ ...registry, previewConfig: config, theme })
    yield* registries.update(updated)
    const rebuilding = changed ? yield* schedulePreviews(registry.id) : 0
    return { registry: updated, rebuilding }
  })

// ---------------------------------------------------------------------------
// 同期時の判定 (registry.json のテーマ系アイテム)
// ---------------------------------------------------------------------------

/**
 * 自動で上書きしてよい状態か。運営者が手で決めたテーマ (manual) だけは上書きせず、提案に留める。
 * v0.7 からテーマは全自動 (承認待ちを作らない)。おかしなものは閲覧者が GitHub Issues (theme-wrong) で報告する
 */
const canAutoApply = (theme: RegistryTheme) => !(theme._tag === "Resolved" && theme.source === "manual")

/**
 * エージェントの提案を承認なしで適用してよいか。validateThemeConfig は通っている前提で、
 * 確信度が low でなく、根拠 (インストール手順の引用) が 1 つ以上あること。満たさなければ neutral のまま提案として残す
 */
export const canAutoApplyProposal = (proposal: ThemeProposal) => proposal.confidence !== "low" && proposal.evidence.length > 0

/**
 * 同期で取得したテーマ系アイテムから、レジストリのテーマを決める。判定の入力 (inputHash) が前回と同じなら何もしない。
 * 戻り値の needsAgent が true なら、呼び出し側 (SyncRegistryWorkflow) がエージェントを回す。
 */
export const resolveThemeOnSync = (registryId: RegistryId, candidates: ReadonlyArray<ThemeCandidate>, options: { readonly force?: boolean } = {}) =>
  Effect.gen(function* () {
    const registry = yield* loadRegistry(registryId)
    const { previewBuild, themeAgent } = yield* ExplorerConfig
    const now = yield* Clock.currentTimeMillis
    const detection = detectThemeFromItems(candidates)
    const current = registry.theme
    if (!options.force && current._tag !== "Unresolved" && current.inputHash === detection.inputHash) {
      return { needsAgent: false, theme: current }
    }
    const resolved = (source: "registry-item" | "none", note: string): RegistryTheme => ({
      _tag: "Resolved",
      inputHash: detection.inputHash,
      source,
      note,
      resolvedAt: now,
    })

    switch (detection._tag) {
      case "Collection":
      case "Neutral": {
        const note =
          detection._tag === "Collection"
            ? `テーマ系アイテムが ${detection.count} 個あるテーマ集なので neutral のまま`
            : `shadcn init が入れるスタイル "${detection.item}" はテーマを持たないので neutral のまま`
        // 運営者が決めたテーマは残す
        if (!canAutoApply(current)) return { needsAgent: false, theme: current }
        // 自動で決めたテーマが残っていれば外す
        const theme = resolved("none", note)
        yield* applyPreviewConfig(registry, withThemeConfig(registry.previewConfig, {}), theme)
        return { needsAgent: false, theme }
      }
      case "Detected": {
        // 既定が決まらない複数候補 (確信度 medium) も、手で決めたテーマが無ければそのまま適用する
        if (canAutoApply(current)) {
          const theme = resolved("registry-item", detection.proposal.notes)
          yield* applyPreviewConfig(registry, withThemeConfig(registry.previewConfig, detection.proposal.config), theme)
          return { needsAgent: false, theme }
        }
        const theme: RegistryTheme = { _tag: "Proposed", inputHash: detection.inputHash, proposal: detection.proposal, proposedAt: now }
        yield* (yield* RegistryRepository).update(new Registry({ ...registry, theme }))
        return { needsAgent: false, theme }
      }
      case "NoCandidates": {
        // 運営者が決めたテーマがあり、強制でもなければそのまま
        if (!options.force && current._tag === "Resolved" && (current.source === "manual" || current.source === "agent")) {
          return { needsAgent: false, theme: current }
        }
        if (!themeAgent || previewBuild.agent === null) {
          const theme = resolved("none", "registry.json にテーマ系アイテムが無く、エージェントが無効なので neutral のまま")
          yield* (yield* RegistryRepository).update(new Registry({ ...registry, theme }))
          return { needsAgent: false, theme }
        }
        const theme: RegistryTheme = { _tag: "AgentPending", inputHash: detection.inputHash, startedAt: now }
        yield* (yield* RegistryRepository).update(new Registry({ ...registry, theme }))
        return { needsAgent: true, theme }
      }
    }
  })

// ---------------------------------------------------------------------------
// 運営者の操作
// ---------------------------------------------------------------------------

export const approveThemeProposal = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const registry = yield* loadRegistry(registryId)
    const theme = registry.theme
    if (theme._tag !== "Proposed") return yield* new ThemeProposalNotFound({ registryId })
    const now = yield* Clock.currentTimeMillis
    const { rebuilding } = yield* applyPreviewConfig(registry, withThemeConfig(registry.previewConfig, theme.proposal.config), {
      _tag: "Resolved",
      inputHash: theme.inputHash,
      source: theme.proposal.source,
      note: theme.proposal.notes,
      resolvedAt: now,
    })
    return { rebuilding }
  })

export const rejectThemeProposal = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const registry = yield* loadRegistry(registryId)
    const theme = registry.theme
    if (theme._tag !== "Proposed") return yield* new ThemeProposalNotFound({ registryId })
    const now = yield* Clock.currentTimeMillis
    yield* (yield* RegistryRepository).update(
      new Registry({
        ...registry,
        theme: { _tag: "Resolved", inputHash: theme.inputHash, source: "none", note: "運営者が提案を却下した", resolvedAt: now },
      }),
    )
  })

/** テーマを判定し直す (同期を強制モードで投入する。registry.json → 必要ならエージェント) */
export const requestThemeDetection = (registryId: RegistryId) =>
  Effect.gen(function* () {
    yield* loadRegistry(registryId)
    yield* (yield* JobScheduler).scheduleSync(registryId, { forceTheme: true })
  })

// ---------------------------------------------------------------------------
// エージェント (インストール手順を読む)
// ---------------------------------------------------------------------------

/** theme.json (エージェントの成果物) の形 */
const AgentThemeOutput = Schema.Struct({
  build: Schema.optional(
    Schema.Struct({
      baseItems: Schema.optional(Schema.Array(Schema.String)),
      themeVars: Schema.optional(TokenMap),
      fonts: Schema.optional(Schema.Array(Schema.String)),
      css: Schema.optional(Schema.String),
    }),
  ),
  tokens: Schema.optional(ThemeTokens),
  variants: Schema.optional(Schema.Array(ThemeVariant)),
  // 長さの上限は切り詰めてから ThemeProposal で検証する (根拠が長いだけで提案全体を捨てない)
  evidence: Schema.optionalWith(Schema.Array(Schema.Struct({ url: Schema.String, quote: Schema.String })), { default: () => [] }),
  confidence: Schema.optionalWith(ThemeConfidence, { default: () => "low" as const }),
  notes: Schema.optionalWith(Schema.String, { default: () => "" }),
})

/** docs で優先して読むページ */
const DOC_PAGE = /(install|getting-started|get-started|setup|quick-?start|theme|theming|styling|customi[sz]|globals|usage|introduction)/i
const MAX_DOC_PAGES = 4
const MAX_DOC_CHARS = 30_000
const SAMPLE_NAMES = /^(button|card|badge|input|alert|tabs|switch)$/

/** レジストリ自身の URL (テーマ用アイテムの配信元として許すもの) */
const urlsOf = (registry: Registry): ReadonlyArray<string> =>
  [registry.homepage, registry.locator.indexUrl, registry.locator.itemUrlTemplate.replace("{name}", "x")].filter(
    (u): u is string => u !== null && u !== "",
  )

const hostsOf = (registry: Registry): ReadonlyArray<string> =>
  urlsOf(registry).flatMap((u) => {
    if (!u) return []
    try {
      return [new URL(u).hostname.toLowerCase()]
    } catch {
      return []
    }
  })

/** ホームページのリンクからインストール手順・テーマのページを決定的に選び、Markdown にして渡す (読めなければ空) */
const readDocs = (registry: Registry, allowedHosts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const reader = yield* DocsReader
    if (!registry.homepage) return []
    const home = registry.homepage
    const links = yield* reader.links(home).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
    const sameSite = (u: string) => {
      try {
        const h = new URL(u).hostname.toLowerCase().replace(/^www\./, "")
        return allowedHosts.some((a) => {
          const b = a.replace(/^www\./, "")
          return h === b || h.endsWith(`.${b}`) || b.endsWith(`.${h}`)
        })
      } catch {
        return false
      }
    }
    const candidates = [...new Set(links.map((l) => l.split("#")[0]!))]
      .filter((u) => u.startsWith("https://") && sameSite(u) && DOC_PAGE.test(new URL(u).pathname))
      // 短いパス (= 上位のページ) を優先する
      .sort((a, b) => new URL(a).pathname.length - new URL(b).pathname.length)
      .slice(0, MAX_DOC_PAGES)
    const pages = yield* Effect.forEach([home, ...candidates], (url) =>
      reader.read(url).pipe(
        Effect.map((p) => [{ url: p.url, markdown: p.markdown.slice(0, MAX_DOC_CHARS) }]),
        Effect.orElseSucceed(() => []),
      ),
    )
    return pages.flat()
  })

/** 候補のテーマで試しにビルドする代表アイテム (button / card などを優先。既存のデモがあれば渡す) */
const sampleItems = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const visual = yield* visualComponents(registryId)
    const ranked = [...visual.filter((r) => SAMPLE_NAMES.test(r.snapshot.name)), ...visual.filter((r) => r.snapshot.kind === "ui")]
    const picked = [...new Map([...ranked, ...visual].map((r) => [r.snapshot.id, r] as const)).values()].slice(0, 3)
    return yield* Effect.forEach(picked, (r) =>
      Effect.gen(function* () {
        const source = yield* blobs.get(itemSourceKey(r.snapshot.id, r.snapshot.contentHash))
        const p = r.enrichment.preview
        const demoKey = p._tag === "Built" || p._tag === "Captured" ? p.demoKey : undefined
        const demo = demoKey ? yield* blobs.get(demoKey) : Option.none()
        return {
          name: r.snapshot.name,
          itemJson: Option.match(source, { onNone: () => null, onSome: (b) => JSON.parse(new TextDecoder().decode(b)) as unknown }),
          demo: Option.match(demo, { onNone: () => null, onSome: (b) => new TextDecoder().decode(b) }),
          layout: demoLayoutOf(r.snapshot.kind),
        }
      }),
    ).pipe(Effect.map((samples) => samples.filter((s) => s.itemJson !== null)))
  })

const knownRegistries = Effect.gen(function* () {
  const all = yield* (yield* RegistryRepository).list()
  return Object.fromEntries(all.flatMap((r) => (r.namespace ? [[r.namespace, r.locator.itemUrlTemplate] as const] : []))) as Record<
    string,
    string
  >
})

/**
 * エージェントへの入力 (ドキュメント・代表アイテムなど)。判定 1 回につき 1 度だけ組み立てて R2 に置き、
 * 起動の再試行 (Workflow のリトライ) では同じものを渡す。読み直すとドキュメントの中身が変わり得て、
 * 同じ冪等性キーで違うリクエストを送ることになる (Agents API が 409 で拒否する)
 */
const themeAgentInput = (registry: Registry, startedAt: number) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore
    const key = `theme-agent/${registry.id}/${startedAt}.json`
    const stored = yield* blobs.get(key)
    if (Option.isSome(stored)) return JSON.parse(new TextDecoder().decode(stored.value)) as Omit<ThemeAgentInput, "registry">
    const allowedHosts = hostsOf(registry)
    const input: Omit<ThemeAgentInput, "registry"> = {
      items: (yield* (yield* ComponentRepository).list({ registryId: registry.id, limit: 500, offset: 0 })).map((r) => ({
        name: r.snapshot.name,
        type: r.snapshot.kind,
        description: r.snapshot.description,
      })),
      samples: yield* sampleItems(registry.id),
      registries: yield* knownRegistries,
      docs: yield* readDocs(registry, allowedHosts),
      allowedHosts,
    }
    yield* blobs.put(key, JSON.stringify(input), "application/json")
    return input
  })

const finishAgent = (registry: Registry, theme: RegistryTheme) =>
  Effect.gen(function* () {
    yield* (yield* RegistryRepository).update(new Registry({ ...registry, theme }))
    // プレビューの保留が解けたので、今の設定 (neutral か既存の設定) で作る。承認されたら作り直す (デモは再利用)
    yield* schedulePreviews(registry.id)
    return theme
  })

/** エージェントを起動する。AgentPending でない・予算切れ・起動失敗なら None (状態は Failed にする) */
export const startThemeAgent = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const registry = yield* loadRegistry(registryId)
    if (registry.theme._tag !== "AgentPending") return Option.none<PreviewAgentJob>()
    const { inputHash, startedAt } = registry.theme
    const { previewBuild } = yield* ExplorerConfig
    const now = yield* Clock.currentTimeMillis
    const fail = (reason: string) =>
      Effect.as(finishAgent(registry, { _tag: "Failed", inputHash, reason, failedAt: now }), Option.none<PreviewAgentJob>())
    if (previewBuild.agent === null) return yield* fail("agent disabled")
    const spent = yield* (yield* UsageLedger).spentSince(monthStart(now), "agent")
    if (spent >= previewBuild.agent.monthlyBudget) return yield* fail("monthly agent budget reached")

    const started = yield* Effect.either(
      Effect.gen(function* () {
        const input = yield* themeAgentInput(registry, startedAt)
        return yield* (yield* ThemeAgent).start({ registry, ...input })
      }),
    )
    if (started._tag === "Left") {
      if (started.left._tag === "PersistenceError") return yield* started.left
      const error = started.left as { readonly _tag: string; readonly reason?: unknown }
      return yield* fail(`agent failed to start: ${String(error.reason ?? error._tag)}`)
    }
    return Option.some(started.right)
  })

/**
 * エージェントの完了を確認する。Running なら None。
 * 完了したら theme.json を検証し、通れば Proposed (運営者の承認待ち)。どの結果でもプレビューの保留を解く。
 */
export const collectThemeAgent = (registryId: RegistryId, job: PreviewAgentJob) =>
  collectThemeOutcome(registryId, job).pipe(
    Effect.tap((theme) =>
      Option.isSome(theme)
        ? emit({ registryId, componentId: null, stage: "theme", status: theme.value._tag === "Failed" ? "warn" : "ok", message: describeTheme(theme.value) })
        : Effect.void,
    ),
    // セッションは結果を保存し終えてから片付ける (保存の前に消すと、Workflow の再試行が消えたセッションを読みに行く)
    Effect.tap((theme) => (Option.isSome(theme) ? Effect.flatMap(ThemeAgent, (agent) => agent.cancel(job)) : Effect.void)),
  )

const collectThemeOutcome = (registryId: RegistryId, job: PreviewAgentJob) =>
  Effect.gen(function* () {
    const registry = yield* loadRegistry(registryId)
    const inputHash = registry.theme._tag === "AgentPending" ? registry.theme.inputHash : ""
    const polled = yield* Effect.either((yield* ThemeAgent).poll(job))
    const now = yield* Clock.currentTimeMillis
    if (polled._tag === "Left") {
      return Option.some(yield* finishAgent(registry, { _tag: "Failed", inputHash, reason: polled.left.reason, failedAt: now }))
    }
    if (polled.right._tag === "Running") return Option.none<RegistryTheme>()

    const { prices } = yield* ExplorerConfig
    yield* (yield* UsageLedger).record(new UsageRecord({
      category: "agent",
      amount: llmCost(polled.right.usage, prices.previewModel),
      subject: `theme:${registryId}`,
      registryId,
      detail: {
        inputTokens: polled.right.usage.inputTokens,
        cachedInputTokens: polled.right.usage.cachedInputTokens,
        outputTokens: polled.right.usage.outputTokens,
        durationMs: polled.right.usage.durationMs,
        theme: 1,
      },
      at: now,
    }))

    const result = polled.right.result
    if (result._tag === "GaveUp") {
      return Option.some(
        yield* finishAgent(registry, { _tag: "Resolved", inputHash, source: "none", note: `agent: ${result.reason}`.slice(0, 2000), resolvedAt: now }),
      )
    }
    const decoded = Schema.decodeUnknownEither(AgentThemeOutput)(result.raw)
    if (decoded._tag === "Left") {
      return Option.some(
        yield* finishAgent(registry, { _tag: "Failed", inputHash, reason: `theme.json does not match the schema: ${decoded.left.message.slice(0, 500)}`, failedAt: now }),
      )
    }
    const out = decoded.right
    const config: ThemeConfig = {
      ...(out.build?.baseItems?.length ? { baseItems: out.build.baseItems } : {}),
      ...(out.build?.themeVars && Object.keys(out.build.themeVars).length > 0 ? { themeVars: out.build.themeVars } : {}),
      ...(out.build?.fonts?.length ? { fonts: out.build.fonts } : {}),
      ...(out.build?.css?.trim() ? { css: out.build.css } : {}),
      ...(out.tokens && Object.keys(out.tokens.light).length > 0 ? { tokens: out.tokens } : {}),
      ...(out.variants?.length ? { variants: out.variants } : {}),
    }
    if (Object.keys(config).length === 0) {
      return Option.some(
        yield* finishAgent(registry, { _tag: "Resolved", inputHash, source: "none", note: `agent: no theme. ${out.notes}`.slice(0, 2000), resolvedAt: now }),
      )
    }
    const problems = validateThemeConfig(config, { registryUrls: urlsOf(registry), namespace: registry.namespace })
    if (problems.length > 0) {
      return Option.some(yield* finishAgent(registry, { _tag: "Failed", inputHash, reason: `rejected: ${problems.join("; ")}`.slice(0, 2000), failedAt: now }))
    }
    // 根拠・メモは表示用なので長すぎる分は切り詰め、それ以外 (設定) は型の上限ごと検証する。通らなければ理由付きの失敗にする
    const decodedProposal = Schema.decodeUnknownEither(ThemeProposal)({
      source: "agent",
      config,
      evidence: out.evidence.slice(0, 10).map((e) => ({ url: e.url.slice(0, 500), quote: e.quote.slice(0, 2000) })),
      confidence: out.confidence,
      notes: out.notes.slice(0, 4000),
    })
    if (decodedProposal._tag === "Left") {
      return Option.some(
        yield* finishAgent(registry, { _tag: "Failed", inputHash, reason: `rejected: ${decodedProposal.left.message}`.slice(0, 2000), failedAt: now }),
      )
    }
    const proposal = decodedProposal.right
    if (!canAutoApplyProposal(proposal)) {
      // 確信度が低い: neutral のまま作り、提案は運営者の画面に残す
      return Option.some(yield* finishAgent(registry, { _tag: "Proposed", inputHash, proposal, proposedAt: now }))
    }
    const theme: RegistryTheme = { _tag: "Resolved", inputHash, source: "agent", note: proposal.notes, resolvedAt: now }
    const applied = yield* applyPreviewConfig(registry, withThemeConfig(registry.previewConfig, proposal.config), theme)
    // 設定が変わらなくても保留は解けたので作る (デモは再利用)
    if (applied.rebuilding === 0) yield* schedulePreviews(registry.id)
    return Option.some(theme)
  })

/** 打ち切り (タイムアウト) */
export const abandonThemeAgent = (registryId: RegistryId, job: PreviewAgentJob, reason: string) =>
  Effect.gen(function* () {
    yield* (yield* ThemeAgent).cancel(job)
    const registry = yield* loadRegistry(registryId)
    const now = yield* Clock.currentTimeMillis
    const inputHash = registry.theme._tag === "AgentPending" ? registry.theme.inputHash : ""
    return yield* finishAgent(registry, { _tag: "Failed", inputHash, reason: `agent timed out: ${reason}`, failedAt: now })
  })

/** エージェントをその場で回す版 (ローカル実行・テスト用。本番は SyncRegistryWorkflow が step.sleep で待つ) */
export const runThemeAgentInline = (registryId: RegistryId) =>
  Effect.gen(function* () {
    const { previewBuild } = yield* ExplorerConfig
    const job = yield* startThemeAgent(registryId)
    if (Option.isNone(job) || previewBuild.agent === null) return Option.none<RegistryTheme>()
    const deadline = (yield* Clock.currentTimeMillis) + previewBuild.agent.timeoutMs
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const theme = yield* collectThemeAgent(registryId, job.value)
      if (Option.isSome(theme)) return theme
      yield* Effect.sleep(previewBuild.agent.pollIntervalMs)
    }
    return Option.some(yield* abandonThemeAgent(registryId, job.value, "timed out"))
  })

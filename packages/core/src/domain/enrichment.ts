import { Data, Schema } from "effect"
import type { ComponentSnapshot } from "./component.js"
import { previewabilityOf } from "./component.js"
import { BUILD_VERSION, BuildKind, CAPTURE_VERSION, PreviewFailureCause, previewSourceHash } from "./demo.js"
import { type RegistryPreviewContext, Timestamp, emptyPreviewContext } from "./registry.js"

/**
 * LLM が生成する「使い方ドキュメント」。
 * ui.shadcn.com/docs/components/* のページを構成できる粒度で持つ。
 *
 * Coding Agent 向けのプロンプトはここに含めない: レジストリ (= 信頼できない入力) を読んだ LLM の出力を
 * そのまま別の Agent への指示にするとプロンプトインジェクションが伝播するため、
 * `agentPromptFor` (agent-prompt.ts) で決定的に組み立てる。
 */
export const UsageExample = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  code: Schema.String,
})
export type UsageExample = typeof UsageExample.Type

export const PropDoc = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  default: Schema.optional(Schema.String),
  description: Schema.String,
})
export type PropDoc = typeof PropDoc.Type

export class UsageDoc extends Schema.Class<UsageDoc>("UsageDoc")({
  summary: Schema.String,
  /** 見た目の説明。意味検索・キーワード検索の両方に効く */
  visualDescription: Schema.String,
  whenToUse: Schema.Array(Schema.String),
  /** import 文と最小の使用例 (TSX のみ) */
  usage: Schema.String,
  examples: Schema.Array(UsageExample),
  props: Schema.Array(PropDoc),
  accessibility: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
}) {}

const FailureFields = {
  sourceHash: Schema.String,
  error: Schema.String,
  attempts: Schema.Number,
  failedAt: Timestamp,
}

/** 生成物がどのソースから作られたかを常に持つ。ハッシュが変わったら古い = 再生成対象。 */
export const DocState = Schema.Union(
  Schema.TaggedStruct("NotGenerated", {}),
  Schema.TaggedStruct("Generated", {
    sourceHash: Schema.String,
    /** 生成に使ったモデル (例: openai:gpt-6-luna) */
    agentPreset: Schema.String,
    generatedAt: Timestamp,
  }),
  Schema.TaggedStruct("Failed", FailureFields),
)
export type DocState = typeof DocState.Type

/**
 * プレビューのライフサイクル。
 *   NotCaptured ─BuildPreview→ Built (HTML あり) ─CapturePreview→ Captured (スクショあり)
 * プレビューの sourceHash は `previewSourceHash(contentHash, buildVersion)` (ソース × ビルド方式の版)。
 * HTML のオブジェクトキーはそこから、スクショは更に撮影方式の版 (captureVersion) も入れて決定的に導出する。
 */
export const PreviewStage = Schema.Literal("build", "capture")
export type PreviewStage = typeof PreviewStage.Type

/** ビルドの由来。どちらが手順を書き、何を回避したか (UI にそのまま出す) */
const BuildInfo = {
  /** ビルドしたデモのソース (src/demo.tsx) の R2 キー。v0.2 の Agent ビルドには無い */
  demoKey: Schema.optional(Schema.String),
  buildKind: Schema.optional(BuildKind),
  /** 素の `shadcn add` からの逸脱 (兄弟アイテムの追加、依存の固定、manifest の操作など) */
  workarounds: Schema.optional(Schema.Array(Schema.String)),
  /** エージェントが書いた manifest の R2 キー (buildKind = agent のとき) */
  manifestKey: Schema.optional(Schema.String),
  /** ビルドに使ったレジストリ設定のハッシュ (buildConfigHash)。無い (v0.5 以前) ものは今の設定で作ったとみなす */
  configHash: Schema.optional(Schema.String),
  /** HTML が実行時のトークン注入 (preview:tokens) に対応しているか (v0.6 のハーネスでビルドしたもの) */
  runtimeTokens: Schema.optional(Schema.Boolean),
}

/** 動くサムネイル (animated WebP)。静止画 (lightKey / darkKey) は常にあり、これはアニメーションする部品だけ */
export const PreviewMotion = Schema.Struct({
  lightKey: Schema.String,
  darkKey: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
})
export type PreviewMotion = typeof PreviewMotion.Type

/** 画像埋め込みの入力 (JPEG)。表示用の静止画が WebP になってから。無い (静止画が PNG の) ものは静止画をそのまま埋め込む */
export const PreviewEmbedImages = Schema.Struct({
  lightKey: Schema.String,
  darkKey: Schema.NullOr(Schema.String),
})
export type PreviewEmbedImages = typeof PreviewEmbedImages.Type

export const PreviewState = Schema.Union(
  Schema.TaggedStruct("NotCaptured", {}),
  Schema.TaggedStruct("Built", {
    sourceHash: Schema.String,
    ...BuildInfo,
    builtAt: Timestamp,
  }),
  Schema.TaggedStruct("Captured", {
    sourceHash: Schema.String,
    lightKey: Schema.String,
    darkKey: Schema.NullOr(Schema.String),
    htmlKey: Schema.NullOr(Schema.String),
    ...BuildInfo,
    /** 撮影方式の版。無い (v0.3 以前) か古ければ、ビルドはそのままで撮り直す */
    captureVersion: Schema.optional(Schema.String),
    motion: Schema.optional(PreviewMotion),
    embedImages: Schema.optional(PreviewEmbedImages),
    /** 撮影時に注入したトークンのハッシュ (tokensHash)。無いものは今のトークンで撮ったとみなす */
    tokensHash: Schema.optional(Schema.String),
    capturedAt: Timestamp,
  }),
  /** ビルダーがプレビュー不要と判断した等。同じソースでは再試行しない */
  Schema.TaggedStruct("Skipped", { reason: Schema.String, sourceHash: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Failed", {
    ...FailureFields,
    /** どの段階で失敗したか。capture で失敗した場合は HTML は既にある (再ビルド不要) */
    stage: Schema.optionalWith(PreviewStage, { default: () => "build" as const }),
    /** 原因。無い (v0.3 以前) ものは infra 扱い */
    cause: Schema.optional(PreviewFailureCause),
    /** このソース・ビルド方式の版で、フォールバックの Coding Agent を既に試したか (1 回だけ) */
    escalated: Schema.optional(Schema.Boolean),
    /** 失敗したときのレジストリ設定のハッシュ。設定が変われば原因を問わず再試行する */
    configHash: Schema.optional(Schema.String),
    /** 失敗する前に使っていたデモ。設定の変更で失敗した場合も、次はデモを書き直さずにビルドする */
    demoKey: Schema.optional(Schema.String),
  }),
)
export type PreviewState = typeof PreviewState.Type

export const IndexState = Schema.Union(
  Schema.TaggedStruct("NotIndexed", {}),
  Schema.TaggedStruct("Indexed", {
    sourceHash: Schema.String,
    /** 画像ベクトルまで入っているか (プレビュー無しのアイテムはテキストのみ) */
    withImage: Schema.Boolean,
    indexedAt: Timestamp,
    /**
     * 埋め込んだ入力のハッシュ (v0.7)。同じなら埋め込み直さない (撮影方式の版上げや作り直しのたびに全件を払い直していた)。
     * textHash = 検索用 Markdown、imageHash = 写っているもの (プレビューのソース × ビルド設定 × トークン)
     */
    textHash: Schema.optional(Schema.String),
    imageHash: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("Failed", FailureFields),
)
export type IndexState = typeof IndexState.Type

export class EnrichmentState extends Schema.Class<EnrichmentState>("EnrichmentState")({
  doc: DocState,
  preview: PreviewState,
  index: IndexState,
}) {
  static readonly initial = new EnrichmentState({
    doc: { _tag: "NotGenerated" },
    preview: { _tag: "NotCaptured" },
    index: { _tag: "NotIndexed" },
  })
}

/**
 * エンリッチメントの各ステップ (Workflow の step に対応)。
 * - GenerateDoc:    LLM 1 回呼び出し (安い)
 * - BuildPreview:   LLM がデモ (demo.tsx) を書き、コンテナのハーネスで決定的にビルド。ビルドエラーは LLM が修正
 * - CapturePreview: Browser Rendering でスクショ
 * - Index:          埋め込み + 検索インデックス
 */
export type EnrichmentStep = Data.TaggedEnum<{
  GenerateDoc: {}
  BuildPreview: {}
  CapturePreview: {}
  Index: { readonly withImage: boolean }
}>
export const EnrichmentStep = Data.taggedEnum<EnrichmentStep>()

/** 予算逼迫時に後回しにできる高コストなステップ */
export const isExpensiveStep = (step: EnrichmentStep): boolean =>
  step._tag === "BuildPreview" || step._tag === "CapturePreview"

export interface EnrichmentPolicy {
  /** 失敗時の最大試行回数。超えたらソースが変わるまで諦める (無限課金を防ぐ) */
  readonly maxAttempts: number
  /** プレビューを作るか (プレビュービルダー未設定・予算方針で落とせるようにフラグ化) */
  readonly capturePreviews: boolean
  /** ビルド方式の版 (BUILD_VERSION)。変わると既存のプレビューは全てデモ生成から作り直し */
  readonly buildVersion: string
  /** 撮影方式の版 (CAPTURE_VERSION)。変わると既存の HTML を撮り直すだけ */
  readonly captureVersion: string
}

export const defaultEnrichmentPolicy: EnrichmentPolicy = {
  maxAttempts: 3,
  capturePreviews: true,
  buildVersion: BUILD_VERSION,
  captureVersion: CAPTURE_VERSION,
}

type Failure = { readonly sourceHash: string; readonly attempts: number }

/** 同じソースで maxAttempts 回失敗したら諦める。ソースが変わったらやり直す */
const canRetry = (failure: Failure, hash: string, policy: EnrichmentPolicy): boolean =>
  failure.sourceHash !== hash || failure.attempts < policy.maxAttempts

const isExhausted = (failure: Failure, hash: string, policy: EnrichmentPolicy): boolean =>
  failure.sourceHash === hash && failure.attempts >= policy.maxAttempts

/**
 * プレビューの失敗を再試行してよいか。原因で決める:
 * registry / harness は同じソース・版では何度やっても同じなので再試行しない (ハッシュか BUILD_VERSION が変われば別物)。
 * demo はモデルの揺らぎで通ることがあるので、エージェントをまだ試していなければ上限まで。infra (と旧データ) は上限まで。
 */
const canRetryPreview = (
  failure: Failure & {
    readonly cause?: PreviewFailureCause | undefined
    readonly escalated?: boolean | undefined
    readonly configHash?: string | undefined
  },
  hash: string,
  policy: EnrichmentPolicy,
  context: RegistryPreviewContext,
): boolean => {
  if (failure.sourceHash !== hash) return true
  if (failure.configHash !== undefined && failure.configHash !== context.configHash) return true
  switch (failure.cause) {
    case "registry":
    case "harness":
      return false
    case "demo":
      return !failure.escalated && failure.attempts < policy.maxAttempts
    default:
      return failure.attempts < policy.maxAttempts
  }
}

/**
 * 現在の状態とソースから、実行すべきステップを決める純粋関数。
 * - ハッシュが一致する成果物は再利用する (コスト 0)
 * - 非ビジュアルなアイテムはプレビューを作らない
 * - capture だけ失敗した場合は、HTML を作り直さずにスクショだけやり直す
 * - レジストリのビルド設定が変わったらビルドし直す (デモは再利用する)。既定のトークンだけ変わったら撮り直すだけ
 *   (HTML が実行時の注入に対応していなければビルドし直す)
 * - レジストリのテーマを調べている間 (context.onHold) はプレビューを作らない
 */
export const planEnrichment = (
  snapshot: Pick<ComponentSnapshot, "kind" | "contentHash">,
  state: EnrichmentState,
  policy: EnrichmentPolicy = defaultEnrichmentPolicy,
  context: RegistryPreviewContext = emptyPreviewContext,
): ReadonlyArray<EnrichmentStep> => {
  const hash = snapshot.contentHash
  const steps: Array<EnrichmentStep> = []

  // --- doc
  const doc = state.doc
  const docWanted =
    doc._tag === "NotGenerated" ||
    (doc._tag === "Generated" && doc.sourceHash !== hash) ||
    (doc._tag === "Failed" && canRetry(doc, hash, policy))
  if (docWanted) steps.push(EnrichmentStep.GenerateDoc())

  // --- preview (鮮度はソース × ビルド方式の版、スクショは更に撮影方式の版で判定する)
  const visual = policy.capturePreviews && previewabilityOf(snapshot.kind)._tag !== "NonVisual"
  const preview = state.preview
  const previewHash = previewSourceHash(hash, policy.buildVersion)
  const built = preview._tag === "Built" || preview._tag === "Captured" ? preview : null
  const configFresh = (configHash: string | undefined) => configHash === undefined || configHash === context.configHash
  const tokensFresh = preview._tag !== "Captured" || (preview.tokensHash ?? context.tokensHash) === context.tokensHash
  const builtFresh =
    built !== null &&
    built.sourceHash === previewHash &&
    configFresh(built.configHash) &&
    // トークンが変わっても、実行時の注入に対応した HTML なら撮り直すだけで済む
    (tokensFresh || built.runtimeTokens === true)
  const capturedFresh =
    preview._tag === "Captured" && builtFresh && preview.captureVersion === policy.captureVersion && tokensFresh
  const htmlFresh =
    builtFresh ||
    (preview._tag === "Failed" && preview.stage === "capture" && preview.sourceHash === previewHash && configFresh(preview.configHash))

  const skippedFresh = preview._tag === "Skipped" && preview.sourceHash === previewHash
  const buildWanted =
    visual &&
    !context.onHold &&
    !htmlFresh &&
    !skippedFresh &&
    (preview._tag !== "Failed" || canRetryPreview(preview, previewHash, policy, context))
  const captureWanted =
    visual &&
    !context.onHold &&
    !capturedFresh &&
    (buildWanted ||
      (htmlFresh && (preview._tag !== "Failed" || canRetryPreview(preview, previewHash, policy, context))))
  if (buildWanted) steps.push(EnrichmentStep.BuildPreview())
  if (captureWanted) steps.push(EnrichmentStep.CapturePreview())

  // --- index
  const withImage = captureWanted || capturedFresh
  const index = state.index
  const indexFresh = index._tag === "Indexed" && index.sourceHash === hash && index.withImage === withImage
  const indexExhausted = index._tag === "Failed" && isExhausted(index, hash, policy)
  if (docWanted || captureWanted || (!indexFresh && !indexExhausted)) {
    steps.push(EnrichmentStep.Index({ withImage }))
  }

  return steps
}

/** 失敗の試行回数を積む (同じソースなら +1、ソースが変わっていたら 1 から) */
export const nextAttempts = (prev: { readonly _tag: string }, hash: string): number =>
  prev._tag === "Failed" && (prev as unknown as Failure).sourceHash === hash
    ? (prev as unknown as Failure).attempts + 1
    : 1

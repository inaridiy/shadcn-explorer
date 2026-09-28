import { Data, Schema } from "effect"
import type { ComponentSnapshot } from "./component.js"
import { previewabilityOf } from "./component.js"
import { Timestamp } from "./registry.js"

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
 * HTML・スクショのオブジェクトキーは (componentId, sourceHash) から決定的に導出する。
 */
export const PreviewStage = Schema.Literal("build", "capture")
export type PreviewStage = typeof PreviewStage.Type

export const PreviewState = Schema.Union(
  Schema.TaggedStruct("NotCaptured", {}),
  Schema.TaggedStruct("Built", {
    sourceHash: Schema.String,
    builtAt: Timestamp,
  }),
  Schema.TaggedStruct("Captured", {
    sourceHash: Schema.String,
    lightKey: Schema.String,
    darkKey: Schema.NullOr(Schema.String),
    htmlKey: Schema.NullOr(Schema.String),
    capturedAt: Timestamp,
  }),
  /** ビルダーがプレビュー不要と判断した等。同じソースでは再試行しない */
  Schema.TaggedStruct("Skipped", { reason: Schema.String, sourceHash: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Failed", {
    ...FailureFields,
    /** どの段階で失敗したか。capture で失敗した場合は HTML は既にある (再ビルド不要) */
    stage: Schema.optionalWith(PreviewStage, { default: () => "build" as const }),
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
 * - BuildPreview:   サンドボックスの Coding Agent がデモを実装・ビルド (高い・遅い)
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
}

export const defaultEnrichmentPolicy: EnrichmentPolicy = { maxAttempts: 3, capturePreviews: true }

type Failure = { readonly sourceHash: string; readonly attempts: number }

/** 同じソースで maxAttempts 回失敗したら諦める。ソースが変わったらやり直す */
const canRetry = (failure: Failure, hash: string, policy: EnrichmentPolicy): boolean =>
  failure.sourceHash !== hash || failure.attempts < policy.maxAttempts

const isExhausted = (failure: Failure, hash: string, policy: EnrichmentPolicy): boolean =>
  failure.sourceHash === hash && failure.attempts >= policy.maxAttempts

/**
 * 現在の状態とソースから、実行すべきステップを決める純粋関数。
 * - ハッシュが一致する成果物は再利用する (コスト 0)
 * - 非ビジュアルなアイテムはプレビューを作らない
 * - capture だけ失敗した場合は、HTML を作り直さずにスクショだけやり直す
 */
export const planEnrichment = (
  snapshot: Pick<ComponentSnapshot, "kind" | "contentHash">,
  state: EnrichmentState,
  policy: EnrichmentPolicy = defaultEnrichmentPolicy,
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

  // --- preview
  const visual = policy.capturePreviews && previewabilityOf(snapshot.kind)._tag !== "NonVisual"
  const preview = state.preview
  const capturedFresh = preview._tag === "Captured" && preview.sourceHash === hash
  const htmlFresh =
    (preview._tag === "Built" && preview.sourceHash === hash) ||
    capturedFresh ||
    (preview._tag === "Failed" && preview.stage === "capture" && preview.sourceHash === hash)

  const skippedFresh = preview._tag === "Skipped" && preview.sourceHash === hash
  const buildWanted =
    visual &&
    !htmlFresh &&
    !skippedFresh &&
    (preview._tag !== "Failed" || canRetry(preview, hash, policy))
  const captureWanted =
    visual &&
    !capturedFresh &&
    (buildWanted ||
      (htmlFresh && (preview._tag !== "Failed" || canRetry(preview, hash, policy))))
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

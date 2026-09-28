import { Data, Schema } from "effect"
import type { ComponentSnapshot } from "./component.js"
import { previewabilityOf } from "./component.js"
import { Timestamp } from "./registry.js"

/**
 * Coding Agent が生成する「使い方ドキュメント」。
 * ui.shadcn.com/docs/components/* のページを構成できる粒度で持つ。
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
  /** 見た目の説明。マルチモーダル検索・キーワード検索の両方に効く */
  visualDescription: Schema.String,
  whenToUse: Schema.Array(Schema.String),
  /** import 文と最小の使用例 */
  usage: Schema.String,
  examples: Schema.Array(UsageExample),
  props: Schema.Array(PropDoc),
  accessibility: Schema.Array(Schema.String),
  /** Coding Agent にそのまま渡せる「このコンポーネントを使って〜」プロンプト */
  agentPrompt: Schema.String,
  keywords: Schema.Array(Schema.String),
}) {}

/** 生成物がどのソースから作られたかを常に持つ。ハッシュが変わったら古い = 再生成対象。 */
export const DocState = Schema.Union(
  Schema.TaggedStruct("NotGenerated", {}),
  Schema.TaggedStruct("Generated", {
    sourceHash: Schema.String,
    agentPreset: Schema.String,
    generatedAt: Timestamp,
  }),
  Schema.TaggedStruct("Failed", {
    sourceHash: Schema.String,
    error: Schema.String,
    attempts: Schema.Number,
    failedAt: Timestamp,
  }),
)
export type DocState = typeof DocState.Type

export const PreviewState = Schema.Union(
  Schema.TaggedStruct("NotCaptured", {}),
  Schema.TaggedStruct("Captured", {
    sourceHash: Schema.String,
    /** R2 上のスクリーンショット (light/dark) と、iframe で表示する静的 HTML */
    lightKey: Schema.String,
    darkKey: Schema.NullOr(Schema.String),
    htmlKey: Schema.NullOr(Schema.String),
    capturedAt: Timestamp,
  }),
  Schema.TaggedStruct("Skipped", { reason: Schema.String }),
  Schema.TaggedStruct("Failed", {
    sourceHash: Schema.String,
    error: Schema.String,
    attempts: Schema.Number,
    failedAt: Timestamp,
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

/** エンリッチメントの各ステップ (Workflow の step に 1:1 対応) */
export type EnrichmentStep = Data.TaggedEnum<{
  GenerateDoc: {}
  CapturePreview: {}
  Index: { readonly withImage: boolean }
}>
export const EnrichmentStep = Data.taggedEnum<EnrichmentStep>()

export interface EnrichmentPolicy {
  /** 失敗時の最大試行回数。超えたらソースが変わるまで諦める (無限課金を防ぐ) */
  readonly maxAttempts: number
  /** プレビュー撮影を行うか (予算逼迫時に落とせるようにフラグ化) */
  readonly capturePreviews: boolean
}

export const defaultEnrichmentPolicy: EnrichmentPolicy = { maxAttempts: 3, capturePreviews: true }

const shouldRetry = (
  state: { readonly _tag: "Failed"; readonly sourceHash: string; readonly attempts: number },
  hash: string,
  policy: EnrichmentPolicy,
): boolean => state.sourceHash !== hash || state.attempts < policy.maxAttempts

/**
 * 現在の状態とソースから、実行すべきステップを決める純粋関数。
 * - ハッシュが一致する成果物は再利用する (コスト 0)
 * - 非ビジュアルなアイテムはスクショを撮らない
 * - プレビューはドキュメント (preview HTML) に依存するので GenerateDoc の後
 * - Index はテキスト/画像のどちらかが更新されたら実行
 */
export const planEnrichment = (
  snapshot: Pick<ComponentSnapshot, "kind" | "contentHash">,
  state: EnrichmentState,
  policy: EnrichmentPolicy = defaultEnrichmentPolicy,
): ReadonlyArray<EnrichmentStep> => {
  const hash = snapshot.contentHash
  const steps: Array<EnrichmentStep> = []

  const doc = state.doc
  const docFresh = doc._tag === "Generated" && doc.sourceHash === hash
  const docWanted =
    doc._tag === "NotGenerated" ||
    (doc._tag === "Generated" && doc.sourceHash !== hash) ||
    (doc._tag === "Failed" && shouldRetry(doc, hash, policy))
  if (docWanted) steps.push(EnrichmentStep.GenerateDoc())

  const visual = previewabilityOf(snapshot.kind)._tag !== "NonVisual"
  const preview = state.preview
  const previewFresh = preview._tag === "Captured" && preview.sourceHash === hash
  const previewWanted =
    visual &&
    policy.capturePreviews &&
    (docFresh || docWanted) &&
    (preview._tag === "NotCaptured" ||
      preview._tag === "Skipped" ||
      (preview._tag === "Captured" && preview.sourceHash !== hash) ||
      (preview._tag === "Failed" && shouldRetry(preview, hash, policy)))
  if (previewWanted) steps.push(EnrichmentStep.CapturePreview())

  const withImage = previewWanted || previewFresh
  const index = state.index
  const indexFresh = index._tag === "Indexed" && index.sourceHash === hash && index.withImage === withImage
  if (!indexFresh || docWanted || previewWanted) steps.push(EnrichmentStep.Index({ withImage }))

  return steps
}

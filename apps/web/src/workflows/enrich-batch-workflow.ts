import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { Option } from "effect"
import { Application } from "@shadcn-explorer/core"
import { type ComponentId, EnrichmentStep } from "@shadcn-explorer/core/domain"
import type { PreviewJob } from "@shadcn-explorer/core/ports"
import type { EnrichParams } from "~/infrastructure/job-scheduler"
import { describeError, runApp } from "~/lib/runtime"

/** step.do の戻り値は構造化クローンされるので、プレーンなオブジェクトにしてやり取りする */
type PlainStep =
  | { readonly _tag: "GenerateDoc" }
  | { readonly _tag: "BuildPreview" }
  | { readonly _tag: "CapturePreview" }
  | { readonly _tag: "Index"; readonly withImage: boolean }

const toDomainStep = (s: PlainStep): EnrichmentStep =>
  s._tag === "Index" ? EnrichmentStep.Index({ withImage: s.withImage }) : EnrichmentStep[s._tag]()

const unwrap = async <A>(promise: ReturnType<typeof runApp<A, { readonly _tag: string }>>): Promise<A> => {
  const result = await promise
  if (result._tag === "Success") return result.value
  if (result._tag === "Failure") throw new Error(describeError(result.error as never).message)
  throw new Error(result.message)
}

/** プレビュービルドの待機: 15 秒 × 最大 100 回 ≈ 25 分 */
const POLL_INTERVAL = "15 seconds"
const MAX_POLLS = 100

/**
 * エンリッチメント Workflow (1 インスタンス = コンポーネントのバッチを逐次処理)。
 *   plan → GenerateDoc (gpt-6-luna) → BuildPreview (サンドボックス Agent, start → sleep/poll)
 *        → CapturePreview (Browser Rendering) → Index (Gemini + D1 FTS5 / Vectorize)
 * - 各ステップは永続化されるので、途中で落ちても完了済みステップ (= 支払済みの AI 呼び出し) は再実行されない
 * - ビルドの待機は step.sleep なので Worker を占有しない
 * - ドメイン層が失敗を状態に記録して成功扱いで返すため、throw するのは永続化エラー等のみ。
 *   それもコンポーネント単位で握りつぶし、バッチの残りは処理を続ける
 */
export class EnrichBatchWorkflow extends WorkflowEntrypoint<Env, EnrichParams> {
  override async run(event: Readonly<WorkflowEvent<EnrichParams>>, step: WorkflowStep) {
    const summary = { done: 0, skipped: 0, failed: 0, deferred: 0, crashed: 0 }
    for (const [i, raw] of event.payload.componentIds.entries()) {
      const componentId = raw as ComponentId
      try {
        const plan = await step.do(`${i}:plan:${componentId}`, { retries: { limit: 3, delay: "10 seconds" } }, async () => {
          const p = await unwrap(runApp(Application.planComponentEnrichment(componentId)))
          return {
            decision: p.decision._tag,
            steps: Application.allowedSteps(p).map(
              (s): PlainStep => (s._tag === "Index" ? { _tag: "Index", withImage: s.withImage } : { _tag: s._tag }),
            ),
          }
        })
        if (plan.decision !== "Proceed") summary.deferred++

        for (const s of plan.steps) {
          const outcome =
            s._tag === "BuildPreview"
              ? await this.buildPreview(step, i, componentId)
              : await step.do(
                  `${i}:${s._tag}:${componentId}`,
                  { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" },
                  async () => (await unwrap(runApp(Application.runEnrichmentStep(componentId, toDomainStep(s)))))._tag,
                )
          if (outcome === "Done") summary.done++
          else if (outcome === "Skipped") summary.skipped++
          else summary.failed++
        }
      } catch (error) {
        // 永続化エラーのリトライも尽きた場合。次回の backlog sweeper が拾い直す
        console.error("enrichment crashed", componentId, error)
        summary.crashed++
      }
    }
    return summary
  }

  /** start → (sleep → poll)* の 2 段階。セッションを待つ間は Workflow が休眠する */
  private async buildPreview(step: WorkflowStep, i: number, componentId: ComponentId): Promise<string> {
    const job = await step.do(`${i}:BuildPreview:start:${componentId}`, { retries: { limit: 2, delay: "30 seconds" } }, async () => {
      const started = await unwrap(runApp(Application.startPreviewBuild(componentId)))
      return Option.getOrNull(started) as PreviewJob | null
    })
    if (job === null) return "Failed"
    for (let n = 0; n < MAX_POLLS; n++) {
      await step.sleep(`${i}:BuildPreview:wait:${n}:${componentId}`, POLL_INTERVAL)
      const polled = await step.do(`${i}:BuildPreview:poll:${n}:${componentId}`, { retries: { limit: 3, delay: "10 seconds" } }, async () => {
        const outcome = await unwrap(runApp(Application.collectPreviewBuild(componentId, job)))
        return Option.match(outcome, { onNone: () => "Running", onSome: (o) => o._tag })
      })
      if (polled !== "Running") return polled
    }
    return step.do(`${i}:BuildPreview:abandon:${componentId}`, async () =>
      (await unwrap(runApp(Application.abandonPreviewBuild(componentId, job, "preview build timed out"))))._tag,
    )
  }
}

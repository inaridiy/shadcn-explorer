import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { Application } from "@shadcn-explorer/core"
import { type ComponentId, EnrichmentStep } from "@shadcn-explorer/core/domain"
import type { EnrichParams } from "~/infrastructure/job-scheduler"
import { describeError, runApp } from "~/lib/runtime"

/** step.do の戻り値は構造化クローンされるので、プレーンなオブジェクトにしてやり取りする */
type PlainStep = { readonly _tag: "GenerateDoc" } | { readonly _tag: "CapturePreview" } | { readonly _tag: "Index"; readonly withImage: boolean }

const toDomainStep = (s: PlainStep): EnrichmentStep =>
  s._tag === "Index" ? EnrichmentStep.Index({ withImage: s.withImage }) : EnrichmentStep[s._tag]()

const unwrap = async <A>(promise: ReturnType<typeof runApp<A, { readonly _tag: string }>>): Promise<A> => {
  const result = await promise
  if (result._tag === "Success") return result.value
  if (result._tag === "Failure") throw new Error(describeError(result.error as never).message)
  throw new Error(result.message)
}

/**
 * エンリッチメント Workflow (1 インスタンス = コンポーネントのバッチを逐次処理)。
 *   plan → GenerateDoc (Coding Agent) → CapturePreview (Browser Rendering) → Index (Gemini + AI Search/Vectorize)
 * 各ステップは永続化されるので、途中で落ちても完了済みステップ (= 支払済みの AI 呼び出し) は再実行されない。
 */
export class EnrichBatchWorkflow extends WorkflowEntrypoint<Env, EnrichParams> {
  override async run(event: Readonly<WorkflowEvent<EnrichParams>>, step: WorkflowStep) {
    const summary = { done: 0, skipped: 0, failed: 0, deferred: 0 }
    for (const [i, componentId] of event.payload.componentIds.entries()) {
      const plan = await step.do(`${i}:plan:${componentId}`, { retries: { limit: 3, delay: "10 seconds" } }, async () => {
        const p = await unwrap(runApp(Application.planComponentEnrichment(componentId as ComponentId)))
        return {
          decision: p.decision._tag,
          steps: Application.allowedSteps(p).map((s): PlainStep => (s._tag === "Index" ? { _tag: "Index", withImage: s.withImage } : { _tag: s._tag })),
        }
      })
      if (plan.decision !== "Proceed") summary.deferred++

      for (const s of plan.steps) {
        const outcome = await step.do(
          `${i}:${s._tag}:${componentId}`,
          {
            retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
            timeout: s._tag === "GenerateDoc" ? "25 minutes" : "5 minutes",
          },
          async () => {
            const o = await unwrap(runApp(Application.runEnrichmentStep(componentId as ComponentId, toDomainStep(s))))
            return o._tag
          },
        )
        if (outcome === "Done") summary.done++
        else if (outcome === "Skipped") summary.skipped++
        else summary.failed++
      }
    }
    return summary
  }
}

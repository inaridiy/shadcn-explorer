import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers"
import { Option } from "effect"
import { Application } from "@shadcn-explorer/core"
import { type ComponentId, EnrichmentStep, RegistryId } from "@shadcn-explorer/core/domain"
import type { PreviewAgentJob } from "@shadcn-explorer/core/ports"
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

/** エージェントの待機: 20 秒 × 最大 45 回 ≈ 15 分 */
const AGENT_POLL_INTERVAL = "20 seconds"
const AGENT_MAX_POLLS = 45

const unwrap = async <A>(promise: ReturnType<typeof runApp<A, { readonly _tag: string }>>): Promise<A> => {
  const result = await promise
  if (result._tag === "Success") return result.value
  if (result._tag === "Failure") throw new Error(describeError(result.error as never).message)
  throw new Error(result.message)
}

/**
 * エンリッチメント Workflow (1 インスタンス = コンポーネントのバッチを逐次処理。キューの消費者は 1 件ずつ起動する)。
 *   plan → GenerateDoc (gpt-6-luna)
 *        → BuildPreview = GenerateDemo (gpt-6-luna) → Compile (Sandbox コンテナ) ⇄ Repair (gpt-6-luna, 最大 2 回)
 *            └ 直せなければ Coding Agent (CF-Open-Agents-API) がビルド手順を書き、Compile で決定的に再実行
 *        → CapturePreview (Browser Rendering: 静止画 + 動く部品は animated WebP) → Index (Gemini + D1 FTS5 / Vectorize)
 * - 各ステップは永続化されるので、途中で落ちても完了済みステップ (= 支払済みの AI 呼び出し) は再実行されない。
 *   デモの生成・修正とコンパイルを別ステップにしているので、コンテナの一時障害で LLM 呼び出しを払い直さない
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
          // 公開ログに「始まった」を出す (このステップは永続化されるので、再実行されても 1 回)
          await runApp(Application.announcePlan(p, RegistryId.make(componentId.split(":")[0]!)))
          return {
            decision: p.decision._tag,
            steps: Application.allowedSteps(p).map(
              (s): PlainStep => (s._tag === "Index" ? { _tag: "Index", withImage: s.withImage } : { _tag: s._tag }),
            ),
          }
        })
        if (plan.decision !== "Proceed") summary.deferred++

        for (const s of plan.steps) {
          const runStep = (label: string) =>
            step.do(
              `${i}:${label}:${componentId}`,
              { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" },
              async () => (await unwrap(runApp(Application.runEnrichmentStep(componentId, toDomainStep(s)))))._tag,
            )
          let outcome: string
          if (s._tag === "BuildPreview") {
            outcome = await this.buildPreview(step, i, componentId)
            // 決まった手順で直せなければ、フォールバックの Coding Agent にビルド手順を書かせる (上限・予算の内側だけ)
            if (outcome === "Failed") outcome = (await this.escalate(step, i, componentId, "build")) ?? outcome
          } else if (s._tag === "CapturePreview") {
            outcome = await runStep(s._tag)
            // 描画時の例外 (demo 起因) もエージェントの対象。直ったら撮り直す
            if (outcome === "Failed" && (await this.escalate(step, i, componentId, "capture")) === "Done") {
              outcome = await runStep(`${s._tag}:after-agent`)
            }
          } else {
            outcome = await runStep(s._tag)
          }
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

  /** GenerateDemo → (Compile → Repair)* 。デモのソースは R2 にあり、ステップ間では試行番号だけを受け渡す */
  private async buildPreview(step: WorkflowStep, i: number, componentId: ComponentId): Promise<string> {
    const llm: WorkflowStepConfig = { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "5 minutes" }
    const first = await step.do(`${i}:BuildPreview:demo:${componentId}`, llm, async (): Promise<number | null> =>
      Option.getOrNull(await unwrap(runApp(Application.generateDemo(componentId)))),
    )
    if (first === null) return "Failed"
    let attempt = first
    for (;;) {
      const outcome = await step.do(
        `${i}:BuildPreview:compile:${attempt}:${componentId}`,
        { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" },
        async () => {
          const o = await unwrap(runApp(Application.compileDemo(componentId, attempt)))
          return o._tag === "Repair" ? { _tag: o._tag, problems: [...o.problems] } : { _tag: o._tag }
        },
      )
      if (outcome._tag !== "Repair") return outcome._tag
      const n = attempt
        const next = await step.do(`${i}:BuildPreview:repair:${n}:${componentId}`, llm, async (): Promise<number | null> =>
        Option.getOrNull(await unwrap(runApp(Application.repairDemo(componentId, n, outcome.problems)))),
      )
      // 修正できなかった: 前の試行でビルドできていれば Built のまま (撮影へ進む)、できていなければ Failed が記録済み
      if (next === null) return "Done"
      attempt = next
    }
  }

  /**
   * フォールバックの Coding Agent: start → (sleep → poll)*。エージェントを待つ間は Workflow が休眠する。
   * 回さない (上限・予算・原因が infra など) 場合は null。
   */
  private async escalate(step: WorkflowStep, i: number, componentId: ComponentId, phase: string): Promise<string | null> {
    // セッション作成にはサンドボックスのセットアップ (ハーネスの依存インストール) が含まれるので長めに待つ
    const job = await step.do(
      `${i}:Agent:${phase}:start:${componentId}`,
      { retries: { limit: 1, delay: "1 minute" }, timeout: "15 minutes" },
      async () => Option.getOrNull(await unwrap(runApp(Application.startPreviewAgent(componentId)))) as PreviewAgentJob | null,
    )
    if (job === null) return null
    for (let n = 0; n < AGENT_MAX_POLLS; n++) {
      await step.sleep(`${i}:Agent:${phase}:wait:${n}:${componentId}`, AGENT_POLL_INTERVAL)
      const polled = await step.do(
        `${i}:Agent:${phase}:poll:${n}:${componentId}`,
        { retries: { limit: 3, delay: "20 seconds" }, timeout: "10 minutes" },
        async () => {
          const outcome = await unwrap(runApp(Application.collectPreviewAgent(componentId, job)))
          return Option.match(outcome, { onNone: () => "Running", onSome: (o) => o._tag })
        },
      )
      if (polled !== "Running") return polled
    }
    return step.do(`${i}:Agent:${phase}:abandon:${componentId}`, async () =>
      (await unwrap(runApp(Application.abandonPreviewAgent(componentId, job, "agent timed out"))))._tag,
    )
  }
}

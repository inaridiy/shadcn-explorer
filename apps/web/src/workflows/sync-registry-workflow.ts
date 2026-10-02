import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { Option } from "effect"
import { Application } from "@shadcn-explorer/core"
import type { PreviewAgentJob } from "@shadcn-explorer/core/ports"
import type { SyncParams } from "~/infrastructure/job-scheduler"
import { describeError, runApp } from "~/lib/runtime"

/** リトライしても結果が変わらない失敗 */
const PERMANENT = new Set(["RegistryNotFoundById", "IllegalRegistryTransition", "InvalidRegistryInput"])

/** テーマのエージェントの待機: 20 秒 × 最大 45 回 ≈ 15 分 (超えたら打ち切り、プレビューの保留を解く) */
const THEME_POLL_INTERVAL = "20 seconds"
const THEME_MAX_POLLS = 45

const unwrap = async <A>(promise: ReturnType<typeof runApp<A, { readonly _tag: string }>>): Promise<A> => {
  const result = await promise
  if (result._tag === "Success") return result.value
  if (result._tag === "Failure") throw new Error(describeError(result.error as never).message)
  throw new Error(result.message)
}

/**
 * レジストリ同期 Workflow。
 * 1. syncRegistry (差分計算 → テーマの判定 → エンリッチのキューへの投入) を 1 ステップで実行する
 * 2. テーマが registry.json で決まらなければ、エージェントにインストール手順を読ませる (start → (sleep → poll)*)。
 *    その間そのレジストリのプレビューは保留され (planEnrichment)、終われば保留を解いて投入し直す
 */
export class SyncRegistryWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  override async run(event: Readonly<WorkflowEvent<SyncParams>>, step: WorkflowStep) {
    const { registryId, forceTheme } = event.payload
    const report = await step.do(
      "sync registry",
      { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" },
      async () => {
        const result = await runApp(Application.syncRegistry(registryId, { forceTheme: forceTheme === true }))
        if (result._tag === "Success") return { ...result.value, warnings: result.value.warnings.slice(0, 50) }
        if (result._tag === "Failure") {
          const info = describeError(result.error as never)
          if (PERMANENT.has(info.code)) throw new NonRetryableError(info.message)
          throw new Error(info.message)
        }
        throw new Error(result.message)
      },
    )
    if (!report.themeAgent) return report

    // セッション作成にはサンドボックスのセットアップ (ハーネスの依存インストール) が含まれるので長めに待つ
    const job = await step.do("theme agent: start", { retries: { limit: 1, delay: "1 minute" }, timeout: "15 minutes" }, async () =>
      Option.getOrNull(await unwrap(runApp(Application.startThemeAgent(registryId)))) as PreviewAgentJob | null,
    )
    if (job === null) return { ...report, theme: "not started" }
    for (let n = 0; n < THEME_MAX_POLLS; n++) {
      await step.sleep(`theme agent: wait ${n}`, THEME_POLL_INTERVAL)
      const theme = await step.do(`theme agent: poll ${n}`, { retries: { limit: 3, delay: "20 seconds" }, timeout: "10 minutes" }, async () => {
        const outcome = await unwrap(runApp(Application.collectThemeAgent(registryId, job)))
        return Option.match(outcome, { onNone: () => "Running", onSome: (t) => t._tag })
      })
      if (theme !== "Running") return { ...report, theme }
    }
    const abandoned = await step.do("theme agent: abandon", async () =>
      (await unwrap(runApp(Application.abandonThemeAgent(registryId, job, "agent timed out"))))._tag,
    )
    return { ...report, theme: abandoned }
  }
}

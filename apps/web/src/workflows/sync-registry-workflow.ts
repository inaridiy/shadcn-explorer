import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { Application } from "@shadcn-explorer/core"
import type { SyncParams } from "~/infrastructure/job-scheduler"
import { describeError, runApp } from "~/lib/runtime"

/** リトライしても結果が変わらない失敗 */
const PERMANENT = new Set(["RegistryNotFoundById", "IllegalRegistryTransition", "InvalidRegistryInput"])

/**
 * レジストリ同期 Workflow。
 * syncRegistry ユースケースを 1 ステップで実行する (内部で差分計算 → エンリッチ Workflow の投入まで行う)。
 */
export class SyncRegistryWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  override async run(event: Readonly<WorkflowEvent<SyncParams>>, step: WorkflowStep) {
    return step.do(
      "sync registry",
      { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" },
      async () => {
        const result = await runApp(Application.syncRegistry(event.payload.registryId))
        if (result._tag === "Success") return { ...result.value, warnings: result.value.warnings.slice(0, 50) }
        if (result._tag === "Failure") {
          const info = describeError(result.error as never)
          if (PERMANENT.has(info.code)) throw new NonRetryableError(info.message)
          throw new Error(info.message)
        }
        throw new Error(result.message)
      },
    )
  }
}

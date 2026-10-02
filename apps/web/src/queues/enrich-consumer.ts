import { Application } from "@shadcn-explorer/core"
import type { ComponentId } from "@shadcn-explorer/core/domain"
import { acquireLease, extendLease, releaseLease } from "~/infrastructure/enrich-leases"
import type { EnrichMessage, EnrichParams } from "~/infrastructure/job-scheduler"
import { runApp } from "~/lib/runtime"

/** 消費者が止まっても、この時間が過ぎれば他のメッセージが lease を取れる。待っている間は延長し続ける */
const LEASE_TTL_MS = 20 * 60_000
const POLL_INTERVAL_MS = 10_000
/** 消費者の実行時間の上限 (15 分) より手前で切り上げ、再配信で同じ Workflow の続きを待つ */
const MAX_WAIT_MS = 12 * 60_000
/** 同じコンポーネントを別のメッセージが処理中なら、終わった頃にもう一度計画する (たいていやることは残っていない) */
const BUSY_RETRY_SECONDS = 120
const TERMINAL = new Set<InstanceStatus["status"]>(["complete", "errored", "terminated"])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const findInstance = async (env: Env, id: string) => {
  try {
    return await env.ENRICH_WORKFLOW.get(id)
  } catch {
    return null
  }
}

/**
 * エンリッチのキューの消費者 (1 メッセージ = 1 コンポーネント)。
 *   計画 → (やることがあれば) lease → Workflow を起動 → 終わるまで待つ → lease を返す
 * - Workflow の終了を待つので、消費者の max_concurrency がそのまま全体の同時実行数になる
 * - 実際の処理は今まで通り Workflow のステップで永続化する (コンテナの一時障害で LLM 呼び出しを払い直さない)
 * - 計画が空 (処理済み・予算で後回し・失敗の上限) なら Workflow を起動しない。backlog sweeper や再同期が同じものを
 *   何度投入しても、ここで落ちる
 */
export const consumeEnrichment = async (batch: MessageBatch<EnrichMessage>, env: Env) => {
  for (const message of batch.messages) {
    try {
      await consumeOne(message, env)
    } catch (error) {
      console.error("enrich consumer failed", message.body.componentId, error)
      message.retry({ delaySeconds: 60 })
    }
  }
}

const consumeOne = async (message: Message<EnrichMessage>, env: Env) => {
  const componentId = message.body.componentId as ComponentId
  const plan = await runApp(Application.planComponentEnrichment(componentId))
  if (plan._tag !== "Success") {
    // 投入後に削除されたコンポーネント
    if (plan._tag === "Failure" && plan.error._tag === "ComponentNotFound") return message.ack()
    return message.retry({ delaySeconds: 60 })
  }
  if (Application.allowedSteps(plan.value).length === 0) return message.ack()

  const lease = await acquireLease(env.DB, componentId, message.id, LEASE_TTL_MS)
  if (lease === null) return message.retry({ delaySeconds: BUSY_RETRY_SECONDS })

  // 再配信 (前回は待ちきれずに切り上げた) なら、起動済みの Workflow の続きを待つ
  let instance = lease.instanceId ? await findInstance(env, lease.instanceId) : null
  if (instance === null) {
    instance = await env.ENRICH_WORKFLOW.create({ params: { componentIds: [componentId] } satisfies EnrichParams })
    await extendLease(env.DB, componentId, message.id, instance.id, LEASE_TTL_MS)
  }

  const started = Date.now()
  for (;;) {
    const { status } = await instance.status()
    if (TERMINAL.has(status)) break
    if (Date.now() - started > MAX_WAIT_MS) return message.retry({ delaySeconds: 5 })
    await sleep(POLL_INTERVAL_MS)
    await extendLease(env.DB, componentId, message.id, instance.id, LEASE_TTL_MS)
  }
  // errored は永続化エラーのリトライが尽きた場合だけ。次の backlog sweeper が拾い直す
  await releaseLease(env.DB, componentId, message.id)
  message.ack()
}

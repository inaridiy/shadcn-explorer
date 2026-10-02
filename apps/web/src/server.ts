import handler from "@tanstack/react-start/server-entry"
import { Application } from "@shadcn-explorer/core"
import api from "./api/app"
import type { EnrichMessage } from "./infrastructure/job-scheduler"
import { Effect } from "effect"
import { type RunResult, runApp } from "./lib/runtime"
import { runPipelineWatchdog } from "./infrastructure/pipeline-watchdog"
import { consumeEnrichment } from "./queues/enrich-consumer"

// プレビューのビルド用コンテナ (Durable Object)。ContainerProxy はコンテナの外向き通信の中継で、
// ローカル開発 (PC での一括取り込み) ではこれが無いとコンテナからインターネットに出られない (全部 ECONNRESET になる)
export { ContainerProxy, Sandbox } from "@cloudflare/sandbox"
export { EnrichBatchWorkflow } from "./workflows/enrich-batch-workflow"
export { SyncRegistryWorkflow } from "./workflows/sync-registry-workflow"

/** wrangler.jsonc の triggers.crons と揃える */
const WATCHDOG_CRON = "*/10 * * * *"

/** cron の結果。失敗は console.error にして Workers Observability の Issues に載せる */
const logCron = (job: string, result: RunResult<unknown, { readonly _tag: string }>) =>
  result._tag === "Success"
    ? console.log({ event: "cron", job, result: result.value })
    : console.error({ event: "cron_failed", job, error: result._tag === "Failure" ? result.error : result.message })

/** Hono が担当するパス (アプリ外向け API・認証・メディア) */
const isApiPath = (pathname: string) =>
  pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/media/")

/**
 * Worker エントリ。
 * - fetch: 外部 API は Hono、それ以外 (SSR + server fn) は TanStack Start
 * - scheduled: 日次で全レジストリを再同期 + backlog sweeper
 * - queue: エンリッチのキュー (1 件ずつ Workflow を起動して待つ。全体の同時実行数はキューの max_concurrency)
 * - Workflow クラス: 同期・エンリッチメント
 */
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    if (isApiPath(pathname)) return api.fetch(request, env, ctx)
    return handler.fetch(request)
  },
  async scheduled(controller, env, ctx) {
    // 10 分ごと: パイプラインの見張りだけ (異常は console.error → Issues)
    if (controller.cron === WATCHDOG_CRON) {
      ctx.waitUntil(runPipelineWatchdog(env).catch((e) => console.error({ event: "cron_failed", job: "watchdog", error: String(e) })))
      return
    }
    ctx.waitUntil(
      Promise.all([
        // 公式ディレクトリ: 写しを更新 → backlog が空いていれば ranking の高い順に取り込む
        runApp(Application.syncDirectory.pipe(Effect.zip(Application.intakeDirectory))).then((r) => logCron("directory", r)),
        // 前回の同期から 7 日経ったレジストリを古い順に再同期 (差分がなければ AI コストは 0)
        runApp(Application.scheduleResyncAll).then((r) => logCron("resync", r)),
        // ソースが変わっていない未完了分 (予算で後回し・一時失敗・後から有効化されたプレビュー) を拾い直す
        runApp(Application.scheduleBacklog()).then((r) => logCron("backlog", r)),
        // 公開ログは 30 日で消す
        runApp(Application.prunePipelineLog).then((r) => logCron("prune", r)),
      ]),
    )
  },
  async queue(batch, env) {
    await consumeEnrichment(batch as MessageBatch<EnrichMessage>, env)
  },
} satisfies ExportedHandler<Env>

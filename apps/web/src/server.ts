import handler from "@tanstack/react-start/server-entry"
import { Application } from "@shadcn-explorer/core"
import api from "./api/app"
import { runApp } from "./lib/runtime"

export { EnrichBatchWorkflow } from "./workflows/enrich-batch-workflow"
export { SyncRegistryWorkflow } from "./workflows/sync-registry-workflow"

/** Hono が担当するパス (アプリ外向け API・認証・メディア) */
const isApiPath = (pathname: string) =>
  pathname.startsWith("/api/") || pathname === "/mcp" || pathname.startsWith("/media/")

/**
 * Worker エントリ。
 * - fetch: 外部 API は Hono、それ以外 (SSR + server fn) は TanStack Start
 * - scheduled: 日次で全レジストリを再同期
 * - Workflow クラス: 同期・エンリッチメント
 */
export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url)
    if (isApiPath(pathname)) return api.fetch(request, env, ctx)
    return handler.fetch(request)
  },
  async scheduled(_controller, _env, ctx) {
    ctx.waitUntil(runApp(Application.scheduleResyncAll).then((r) => console.log("resync scheduled", r)))
  },
} satisfies ExportedHandler<Env>

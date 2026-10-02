/**
 * パイプラインの見張り (cron 10 分ごと)。Cloudflare には Queues / Workflows / Containers の詰まりを通知する仕組みが無いので、
 * 異常を見つけたら console.error に構造化して出し、Workers Observability の Issues (→ Webhook) に載せる。
 * 見るもの:
 * - キューの最古のメッセージが 1 時間以上前 (消費者が止まっている・全部が lease 待ちで回っていない)
 * - 期限切れのまま残っている lease (消費者がクラッシュした)
 * - 直近 1 時間の公開ログで、ビルド・撮影の失敗が多すぎる (コンテナのイメージ・ハーネスの不具合)
 */
const STALE_QUEUE_MS = 60 * 60 * 1000
const ERROR_RATIO_THRESHOLD = 0.5
const MIN_SAMPLES = 10

export interface WatchdogReport {
  readonly backlog: number | null
  readonly oldestMessageAgeMs: number | null
  readonly expiredLeases: number
  readonly recentFailures: number
  readonly recentFinished: number
  readonly alerts: ReadonlyArray<string>
}

export const runPipelineWatchdog = async (env: Env): Promise<WatchdogReport> => {
  const now = Date.now()
  const alerts: Array<string> = []

  const metrics = await env.ENRICH_QUEUE.metrics().catch(() => null)
  const oldest = metrics?.oldestMessageTimestamp ? now - new Date(metrics.oldestMessageTimestamp).getTime() : null
  if (oldest !== null && oldest > STALE_QUEUE_MS) alerts.push("enrich_queue_stalled")

  const leases = await env.DB.prepare(`select count(*) as n from enrich_leases where expires_at < ?`)
    .bind(now - 10 * 60 * 1000)
    .first<{ n: number }>()
  const expiredLeases = leases?.n ?? 0
  if (expiredLeases > 0) alerts.push("expired_enrich_leases")

  const recent = await env.DB.prepare(
    `select
       sum(case when status = 'error' and stage in ('build', 'capture') then 1 else 0 end) as failures,
       sum(case when stage = 'index' and status = 'ok' then 1 else 0 end) as finished
     from pipeline_events where at >= ?`,
  )
    .bind(now - 60 * 60 * 1000)
    .first<{ failures: number | null; finished: number | null }>()
  const failures = recent?.failures ?? 0
  const finished = recent?.finished ?? 0
  if (failures + finished >= MIN_SAMPLES && failures / (failures + finished) > ERROR_RATIO_THRESHOLD) {
    alerts.push("preview_failure_spike")
  }

  const report: WatchdogReport = {
    backlog: metrics?.backlogCount ?? null,
    oldestMessageAgeMs: oldest,
    expiredLeases,
    recentFailures: failures,
    recentFinished: finished,
    alerts,
  }
  if (alerts.length > 0) console.error({ event: "pipeline_alert", ...report })
  else console.log({ event: "pipeline_watchdog", ...report })
  return report
}

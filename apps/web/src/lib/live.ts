import * as React from "react"

/**
 * 生成過程の公開ログ (/api/live/*) をポーリングするクライアントのフック。
 * サーバー側はエッジで 2 秒キャッシュしているので、閲覧者が増えても D1 への読みは増えない。
 * タブが見えていない間は止める
 */
export interface LiveEvent {
  readonly id: number
  readonly at: number
  readonly registryId: string
  readonly componentId: string | null
  readonly stage: "sync" | "theme" | "plan" | "docs" | "demo" | "build" | "repair" | "agent" | "capture" | "index"
  readonly status: "start" | "ok" | "warn" | "error" | "info"
  readonly message: string
  /** lightKey / darkKey / motionKey は /media の URL に変換済み。code はデモのソース */
  readonly detail: Readonly<Record<string, string | number>>
}

export interface LiveSummary {
  readonly active: ReadonlyArray<{ componentId: string; registryId: string; startedAt: number; latest: LiveEvent }>
  readonly captured: ReadonlyArray<LiveEvent>
  readonly finishedToday: number
  readonly cursor: number
}

const usePageVisible = () => {
  const [visible, setVisible] = React.useState(true)
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible")
    update()
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return visible
}

/** 1 コンポーネント / 1 レジストリのイベントを、最初に最新 200 件、以降は増分で取り続ける */
export const useLiveEvents = (filter: { readonly componentId?: string; readonly registryId?: string }, intervalMs = 2500) => {
  const [events, setEvents] = React.useState<ReadonlyArray<LiveEvent>>([])
  const [loaded, setLoaded] = React.useState(false)
  const cursor = React.useRef(0)
  const visible = usePageVisible()
  const key = `${filter.componentId ?? ""}|${filter.registryId ?? ""}`

  React.useEffect(() => {
    cursor.current = 0
    setEvents([])
    setLoaded(false)
  }, [key])

  React.useEffect(() => {
    if (!visible) return
    let stopped = false
    const tick = async () => {
      const params = new URLSearchParams()
      if (filter.componentId) params.set("component", filter.componentId)
      if (filter.registryId) params.set("registry", filter.registryId)
      if (cursor.current > 0) params.set("after", String(cursor.current))
      try {
        const res = await fetch(`/api/live/events?${params}`)
        if (!res.ok || stopped) return
        const body = (await res.json()) as { events: ReadonlyArray<LiveEvent>; cursor: number }
        if (stopped) return
        cursor.current = Math.max(cursor.current, body.cursor)
        if (body.events.length > 0) {
          setEvents((prev) => {
            const seen = new Set(prev.map((e) => e.id))
            return [...prev, ...body.events.filter((e) => !seen.has(e.id))]
          })
        }
        setLoaded(true)
      } catch {
        // 一時的な失敗は次の周期で取り直す
      }
    }
    void tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [key, visible, intervalMs])

  return { events, loaded }
}

/** /live とティッカー用の要約 */
export const useLiveSummary = (registryId?: string, intervalMs = 4000) => {
  const [summary, setSummary] = React.useState<LiveSummary | null>(null)
  const visible = usePageVisible()
  React.useEffect(() => {
    if (!visible) return
    let stopped = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/live/summary${registryId ? `?registry=${encodeURIComponent(registryId)}` : ""}`)
        if (res.ok && !stopped) setSummary((await res.json()) as LiveSummary)
      } catch {
        // 次の周期で取り直す
      }
    }
    void tick()
    const timer = setInterval(tick, intervalMs)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [registryId, visible, intervalMs])
  return summary
}

/** コンポーネント ID "registry:name" を分ける */
export const splitComponentId = (id: string) => {
  const i = id.indexOf(":")
  return { registryId: id.slice(0, i), name: id.slice(i + 1) }
}

/** 直近の 1 回の実行 (最後の plan:start 以降) だけを取り出す */
export const latestRun = (events: ReadonlyArray<LiveEvent>) => {
  let start = 0
  events.forEach((e, i) => {
    if (e.stage === "plan" && e.status === "start") start = i
  })
  return events.slice(start)
}

export const PIPELINE_STEPS = [
  { stage: "docs", label: "Docs" },
  { stage: "demo", label: "Demo" },
  { stage: "build", label: "Build" },
  { stage: "capture", label: "Capture" },
  { stage: "index", label: "Index" },
] as const

/** 実行中のステップの位置 (0..5)。index が ok なら完了 */
export const stepIndexOf = (event: LiveEvent) => {
  if (event.stage === "index" && event.status === "ok") return PIPELINE_STEPS.length
  const map: Record<string, number> = { plan: 0, docs: 0, demo: 1, repair: 2, agent: 2, build: 2, capture: 3, index: 4 }
  const base = map[event.stage] ?? 0
  // ステップが ok で終わったら次のステップに進んでいる
  return event.status === "ok" && event.stage !== "plan" && event.stage !== "repair" ? base + 1 : base
}

export const timeAgo = (at: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

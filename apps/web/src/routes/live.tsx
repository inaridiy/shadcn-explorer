import { Link, createFileRoute } from "@tanstack/react-router"
import * as React from "react"
import { SignalDot } from "~/components/listing-badge"
import { type LiveEvent, type LiveSummary, PIPELINE_STEPS, splitComponentId, stepIndexOf, timeAgo, useLiveSummary } from "~/lib/live"
import { cn } from "~/lib/utils"
import { directoryProgressFn } from "~/server/live"

export const Route = createFileRoute("/live")({
  loader: () => directoryProgressFn(),
  head: () => ({ meta: [{ title: "Live builds · shadcn explorer" }] }),
  component: LivePage,
})

/** liveSnapshot が返す撮影済みの上限。これに達したら「24+」と出す (それ以上は数えていない) */
const CAPTURED_CAP = 24

function LivePage() {
  const summary = useLiveSummary(undefined, 3000)
  const building = summary?.active.length ?? null
  const captured = summary ? (summary.captured.length >= CAPTURED_CAP ? `${CAPTURED_CAP}+` : String(summary.captured.length)) : null

  return (
    <div className="flex flex-col gap-7 pt-10">
      <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="flex flex-col gap-2">
          <span className="label-mono inline-flex items-center gap-2 text-signal-foreground">
            <SignalDot pulse className="size-2" />
            Live
          </span>
          <h1 className="text-[32px] leading-none font-semibold tracking-[-0.045em] sm:text-[40px]">Everything building, right now.</h1>
          <p className="max-w-[640px] text-[15px] leading-relaxed text-muted-foreground">
            Each component goes from registry-item.json to a running demo here. Click any row to follow its log.
          </p>
        </div>
        <div className="flex gap-7 sm:gap-9">
          <Stat label="building" value={building === null ? null : String(building)} signal={building !== null && building > 0} />
          <Stat label="finished · 24h" value={summary ? summary.finishedToday.toLocaleString("en-US") : null} />
          <Stat label="captured · 24h" value={captured} />
        </div>
      </div>

      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-5.5">
          <Builders summary={summary} />
          <DirectoryImport />
        </div>
        <JustWentLive summary={summary} />
      </div>
    </div>
  )
}

function Stat({ label, value, signal = false }: { label: string; value: string | null; signal?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 lg:items-end">
      {value === null ? (
        <span className="skeleton my-1 h-7 w-10 rounded" />
      ) : (
        <span className={cn("font-mono text-[28px] font-medium tracking-[-0.03em] tabular-nums", signal && "text-signal-foreground")}>{value}</span>
      )}
      <span className="label-mono">{label}</span>
    </div>
  )
}

function Panel({ label, aside, children, className }: { label: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col overflow-hidden rounded-[14px] border bg-card", className)}>
      <div className="flex items-center justify-between gap-3 border-b px-4.5 py-3.5">
        <span className="label-mono shrink-0">{label}</span>
        {aside && <span className="min-w-0 truncate text-right font-mono text-[11.5px] text-faint">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// ビルド中のレーン
// ---------------------------------------------------------------------------

function Builders({ summary }: { summary: LiveSummary | null }) {
  const active = summary?.active ?? []
  // 今回の実行で撮れたスクショ (撮影の後もしばらく index が走る)
  const shots = React.useMemo(() => {
    const map = new Map<string, LiveEvent>()
    for (const e of summary?.captured ?? []) if (e.componentId && !map.has(e.componentId)) map.set(e.componentId, e)
    return map
  }, [summary])

  return (
    <Panel label="Builders" aside={summary ? (active.length > 0 ? `${active.length} building` : "idle") : undefined}>
      {summary === null ? (
        <div className="flex flex-col">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-4.5 border-b px-4.5 py-3.5 last:border-b-0">
              <span className="skeleton h-[70px] w-[112px] shrink-0 rounded-lg" />
              <span className="skeleton h-4 flex-1 rounded" />
            </div>
          ))}
        </div>
      ) : active.length === 0 ? (
        <IdleBuilders lastCapture={summary.captured[0]} />
      ) : (
        <ul>
          {active.map((a) => {
            const shot = shots.get(a.componentId)
            return (
              <li key={a.componentId} className="border-b last:border-b-0">
                <Lane componentId={a.componentId} latest={a.latest} shot={shot && shot.at >= a.startedAt ? shot : undefined} />
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

function Lane({ componentId, latest, shot }: { componentId: string; latest: LiveEvent; shot: LiveEvent | undefined }) {
  const { registryId, name } = splitComponentId(componentId)
  const step = stepIndexOf(latest)
  const failed = latest.status === "error"
  const stepName = PIPELINE_STEPS[Math.min(step, PIPELINE_STEPS.length - 1)]!.label
  return (
    <Link
      to="/c/$registryId/$name"
      params={{ registryId, name }}
      className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-4 gap-y-3 px-4.5 py-3.5 transition-colors hover:bg-accent/40 sm:grid-cols-[112px_minmax(0,1fr)_240px] sm:gap-x-4.5"
    >
      <div className="stage grid aspect-[16/10] w-full place-items-center overflow-hidden rounded-lg border">
        {shot ? (
          <Shot event={shot} className="size-full animate-rise object-cover" />
        ) : (
          <span className="font-mono text-[10px] text-faint lowercase">{stepName}</span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="truncate font-mono text-sm font-medium">
          <span className="text-muted-foreground">@{registryId}/</span>
          {name}
        </span>
        <span className={cn("truncate font-mono text-xs", failed ? "text-destructive" : latest.status === "warn" ? "text-warning" : "text-muted-foreground")}>
          {latest.message}
        </span>
      </div>
      <div className="col-span-2 flex flex-col gap-2 sm:col-span-1">
        <div className="grid grid-cols-5 gap-1">
          {PIPELINE_STEPS.map((s, k) => (
            <span
              key={s.stage}
              className={cn(
                "h-1.5 rounded-[3px]",
                k < step ? "bg-foreground/70" : k === step ? (failed ? "bg-destructive" : "animate-signal bg-signal") : "bg-muted",
              )}
            />
          ))}
        </div>
        <div className="grid grid-cols-5 font-mono text-[10.5px] text-faint">
          {PIPELINE_STEPS.map((s, k) => (
            <span key={s.stage} className={cn("lowercase", k === step && !failed && "text-signal-foreground")}>
              {s.label}
            </span>
          ))}
        </div>
      </div>
    </Link>
  )
}

/** 何も作っていないとき。空であることを伝えつつ、どうなれば動くかを書く */
function IdleBuilders({ lastCapture }: { lastCapture: LiveEvent | undefined }) {
  return (
    <div className="stage flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="grid grid-cols-5 gap-1">
        {PIPELINE_STEPS.map((s) => (
          <span key={s.stage} className="h-1.5 w-8 rounded-[3px] bg-border" />
        ))}
      </div>
      <span className="text-sm font-medium">All builders are idle</span>
      <span className="max-w-[440px] text-[13px] leading-relaxed text-muted-foreground">
        Builds start when a registry is imported or a re-sync finds changed items. New official registries are imported daily.
      </span>
      {lastCapture?.componentId && (
        <span className="font-mono text-[11.5px] text-faint">
          last capture: @{splitComponentId(lastCapture.componentId).registryId}/{splitComponentId(lastCapture.componentId).name} · {timeAgo(lastCapture.at)}
        </span>
      )}
    </div>
  )
}

/** 撮影イベントのスクショ (ライト / ダークはサイトのテーマに合わせる) */
function Shot({ event, className }: { event: LiveEvent; className?: string }) {
  const light = typeof event.detail.lightKey === "string" ? event.detail.lightKey : null
  const dark = typeof event.detail.darkKey === "string" ? event.detail.darkKey : light
  if (!light) return null
  return (
    <>
      <img src={light} alt="" loading="lazy" decoding="async" className={cn(className, "dark:hidden")} />
      <img src={dark ?? light} alt="" loading="lazy" decoding="async" className={cn(className, "hidden dark:block")} />
    </>
  )
}

// ---------------------------------------------------------------------------
// 撮れたばかりのもの
// ---------------------------------------------------------------------------

function JustWentLive({ summary }: { summary: LiveSummary | null }) {
  const items = (summary?.captured ?? []).filter((e) => e.componentId && typeof e.detail.lightKey === "string").slice(0, 12)
  return (
    <Panel label="Just went live" aside={summary ? `${summary.finishedToday.toLocaleString("en-US")} in 24h` : undefined} className="self-start">
      {summary === null ? (
        <div className="grid grid-cols-2 gap-3 p-3.5">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="skeleton aspect-[16/10] rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="stage flex flex-col items-center gap-2 px-6 py-14 text-center">
          <span className="text-sm font-medium">No captures in the last 24 hours</span>
          <span className="max-w-[300px] text-[13px] text-muted-foreground">Fresh screenshots pop in here the moment a build finishes capturing.</span>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 p-3.5">
          {items.map((e) => {
            const { registryId, name } = splitComponentId(e.componentId!)
            return (
              <li key={e.id} className="animate-rise">
                <Link to="/c/$registryId/$name" params={{ registryId, name }} className="group flex flex-col gap-1.5">
                  <span className="stage block aspect-[16/10] overflow-hidden rounded-lg border transition-colors group-hover:border-ring">
                    <Shot event={e} className="size-full object-cover" />
                  </span>
                  <span className="flex items-baseline justify-between gap-1.5">
                    <span className="truncate font-mono text-[11.5px] text-foreground/85" title={`@${registryId}/${name}`}>
                      {name}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-faint">{timeAgo(e.at).replace(" ago", "")}</span>
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// 公式ディレクトリの取り込み
// ---------------------------------------------------------------------------

function DirectoryImport() {
  const progress = Route.useLoaderData()
  const ratio = progress.eligible > 0 ? progress.imported / progress.eligible : 0
  return (
    <Panel label="Official directory import" aside={
        <>
          {progress.imported} of {progress.eligible}
          <span className="hidden sm:inline"> registries · highest-ranked first</span>
        </>
      }
    >
      {progress.eligible === 0 ? (
        <p className="px-4.5 py-6 text-[13px] text-muted-foreground">The official shadcn directory hasn't been read yet. It's checked once a day.</p>
      ) : (
        <>
          <div className="px-4.5 pt-3.5 pb-3">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground" style={{ width: `${Math.max(1, Math.round(ratio * 100))}%` }} />
            </div>
          </div>
          {progress.next.length === 0 ? (
            <p className="border-t px-4.5 py-3 text-[13px] text-muted-foreground">Everything eligible has been imported.</p>
          ) : (
            <ol>
              {progress.next.map((e, i) => (
                <li
                  key={e.name}
                  className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 border-t px-4.5 py-2.5 text-[13px] sm:grid-cols-[28px_minmax(0,1fr)_90px_70px]"
                >
                  <span className="font-mono text-[11.5px] text-faint">{progress.imported + i + 1}</span>
                  <span className="truncate font-mono text-foreground/85">{e.name}</span>
                  <span className="hidden font-mono text-xs text-muted-foreground sm:block">{e.itemCount !== null ? `${e.itemCount} items` : ""}</span>
                  <span className="text-right font-mono text-[11.5px] text-faint">{i === 0 ? "next" : "queued"}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Panel>
  )
}

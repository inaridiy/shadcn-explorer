import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowLeft, ChevronRight, RotateCcw } from "lucide-react"
import * as React from "react"
import { STEP_STATE_LABEL, StepDot } from "~/components/build-steps"
import { HighlightedCode } from "~/components/code-block"
import { SignalDot } from "~/components/listing-badge"
import { buttonVariants } from "~/components/ui/button"
import {
  type DiffLine,
  type RunOutcome,
  type RunView,
  diffLines,
  formatDuration,
  formatOffset,
  splitRuns,
  stepsFromStatus,
  stepsOf,
} from "~/lib/build-run"
import { type LiveEvent, stepIndexOf, useLiveEvents } from "~/lib/live"
import { cn } from "~/lib/utils"
import { getComponentFn } from "~/server/components"
import type { ComponentDetailDto } from "~/server/dto"

/**
 * ビルドログ (/c/$registryId/$name/build)。公開ログ (/api/live/events) をポーリングして、生成の流れをその場で見せる。
 * `$name_` で親 (コンポーネントのページ) の入れ子から外している (Outlet を持たない独立したページ)。
 * 金額・プロンプト・LLM の生のエラーは出さない (公開ログにも載っていない)
 */
export const Route = createFileRoute("/c/$registryId/$name_/build")({
  loader: ({ params }) => getComponentFn({ data: params }),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `Build log · ${loaderData.title} · ${loaderData.registryId} — Shadcn Explorer` }] : [],
  }),
  component: BuildLogPage,
})

/** パイプラインの各ステップの補足 (何をするステップか) */
const STEP_SUB: Record<string, string> = {
  docs: "usage, props, keywords",
  demo: "src/demo.tsx",
  build: "shadcn add → vite",
  capture: "light, dark, motion",
  index: "BM25 + vectors",
}

const useNow = (active: boolean) => {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

const codeOf = (e: LiveEvent | undefined) => (e && typeof e.detail.code === "string" ? e.detail.code : null)
const isCodeEvent = (e: LiveEvent) => (e.stage === "demo" || e.stage === "repair") && e.status === "ok" && codeOf(e) !== null

// --- ログの行

interface LogLine {
  readonly key: string
  readonly offset: string
  readonly tag: string
  readonly tone: "muted" | "ok" | "warn" | "error"
  readonly message: string
}

const TONE_TAG: Record<LogLine["tone"], string> = {
  muted: "text-zinc-500",
  ok: "text-signal",
  warn: "text-amber-300",
  error: "text-red-400",
}

const toLines = (run: RunView): ReadonlyArray<LogLine> => {
  const lines = run.events.map((e): LogLine => {
    const tone: LogLine["tone"] =
      e.status === "error" ? "error" : e.status === "warn" || (e.stage === "repair" && e.status !== "ok") ? "warn" : e.status === "ok" ? "ok" : "muted"
    const attempt = typeof e.detail.attempt === "number" && e.detail.attempt > 0 && e.stage !== "repair" ? ` · attempt ${e.detail.attempt + 1}` : ""
    return {
      key: String(e.id),
      offset: formatOffset(e.at - run.startedAt),
      tag: e.status === "error" ? "error" : e.stage,
      tone,
      message: `${e.status === "ok" ? "✓ " : ""}${e.message}${attempt}`,
    }
  })
  if (run.outcome === "done") {
    lines.push({
      key: `${run.id}-done`,
      offset: formatOffset(run.endedAt - run.startedAt),
      tag: "live",
      tone: "ok",
      message: `✓ build finished in ${formatDuration(run.endedAt - run.startedAt)}`,
    })
  }
  return lines
}

function LogLines({ lines, animate }: { lines: ReadonlyArray<LogLine>; animate: boolean }) {
  return (
    <>
      {lines.map((l) => (
        <div key={l.key} className={cn("grid grid-cols-[52px_64px_minmax(0,1fr)] gap-2.5 sm:grid-cols-[60px_72px_minmax(0,1fr)]", animate && "animate-rise")}>
          <span className="text-zinc-600 tabular-nums">{l.offset}</span>
          <span className={TONE_TAG[l.tone]}>{l.tag}</span>
          <span className="break-words text-zinc-300">{l.message}</span>
        </div>
      ))}
    </>
  )
}

// --- 状態の札

const PILL: Record<RunOutcome | "none", { label: string; className: string; pulse?: boolean }> = {
  running: { label: "BUILDING", className: "border-signal/45 text-signal-foreground", pulse: true },
  done: { label: "LIVE", className: "text-foreground" },
  failed: { label: "FAILED", className: "border-destructive/45 text-destructive" },
  waiting: { label: "WAITING", className: "text-muted-foreground" },
  stalled: { label: "STALLED", className: "border-warning/45 text-warning" },
  none: { label: "NO RECENT BUILD", className: "text-muted-foreground" },
}

function StatusPill({ outcome }: { outcome: RunOutcome | "none" }) {
  const p = PILL[outcome]
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-[7px] rounded-full border px-2.5 font-mono text-[11px] tracking-[0.06em]", p.className)}>
      {p.pulse ? <SignalDot pulse /> : <span className={cn("size-[7px] rounded-full bg-current")} />}
      {p.label}
    </span>
  )
}

// --- 右の列

function RepairDiff({ before, after, attempt }: { before: string; after: string; attempt: number }) {
  const diff = React.useMemo(() => diffLines(before, after), [before, after])
  const changed = diff.filter((l): l is DiffLine & { kind: "add" | "del" } => l.kind !== "same")
  if (changed.length === 0) return null
  const lineNo = changed[0]!.line
  return (
    <div className="animate-rise mt-3.5 rounded-lg border border-zinc-800 px-3 py-2.5 font-mono text-xs leading-[1.8]">
      <div className="text-zinc-500">
        repair {attempt} · line {lineNo} · {changed.filter((l) => l.kind === "del").length} removed, {changed.filter((l) => l.kind === "add").length} added
      </div>
      {changed.slice(0, 30).map((l, i) => (
        <div key={`${i}-${l.kind}`} className={cn("break-all whitespace-pre-wrap", l.kind === "add" ? "text-lime-300" : "text-red-300")}>
          {l.kind === "add" ? "+ " : "- "}
          {l.text}
        </div>
      ))}
      {changed.length > 30 && <div className="text-zinc-500">… {changed.length - 30} more lines</div>}
    </div>
  )
}

function SidePanel({ d, run, allEvents, replaying }: { d: ComponentDetailDto; run: RunView | undefined; allEvents: ReadonlyArray<LiveEvent>; replaying: boolean }) {
  const events = run?.events ?? []
  const capture = [...events].reverse().find((e) => e.stage === "capture" && e.status === "ok" && typeof e.detail.lightKey === "string")
  // この実行で書いたデモ。無ければ (デモを使い回した実行なら) それより前のログ、最後にページのデモ
  const codeEvent = [...events].reverse().find(isCodeEvent) ?? (replaying ? undefined : [...allEvents].reverse().find(isCodeEvent))
  const code = codeOf(codeEvent) ?? (replaying ? null : d.demoCode)
  const previous = codeEvent?.stage === "repair" ? [...allEvents.slice(0, allEvents.indexOf(codeEvent))].reverse().find(isCodeEvent) : undefined
  const cursor = run && run.outcome === "running" ? stepIndexOf(events.at(-1)!) : null
  const note =
    codeEvent && events.includes(codeEvent)
      ? codeEvent.stage === "repair"
        ? `repaired (fix ${codeEvent.detail.attempt ?? ""})`
        : "written"
      : cursor === 0
        ? "waiting for docs"
        : cursor === 1
          ? "being written"
          : "from an earlier run"
  const shots = capture
    ? [
        { label: "dark", src: typeof capture.detail.darkKey === "string" ? capture.detail.darkKey : null },
        { label: "light", src: capture.detail.lightKey as string },
      ].filter((s): s is { label: string; src: string } => s.src !== null)
    : []
  const motion = typeof capture?.detail.motionKey === "string" ? capture.detail.motionKey : null

  return (
    <div className="flex min-h-0 min-w-0 flex-col lg:border-l">
      {capture && (
        <>
          <div className="flex h-10 shrink-0 items-center border-y px-[18px] lg:border-t-0">
            <span className="label-mono">Captured</span>
          </div>
          <div key={capture.id} className="flex flex-col gap-3.5 border-b p-[18px] animate-reveal">
            <div className="grid grid-cols-2 gap-2.5">
              {shots.map((s) => (
                <img key={s.label} src={s.src} alt={`${d.title}, ${s.label} capture`} className="aspect-[16/10] w-full rounded-lg border object-cover" />
              ))}
            </div>
            {motion && <img src={motion} alt={`${d.title}, motion capture`} className="aspect-[16/10] w-full rounded-lg border object-cover" />}
            <div className="flex justify-between font-mono text-[11.5px] text-faint">
              <span>{shots.map((s) => s.label).join(" · ")}</span>
              <span>{motion ? "moving · recorded" : "still"}</span>
            </div>
            <Link to="/c/$registryId/$name" params={{ registryId: d.registryId, name: d.name }} className={cn(buttonVariants(), "w-full")}>
              Open the live demo
            </Link>
          </div>
        </>
      )}
      <div className="flex h-10 shrink-0 items-center border-y px-[18px] lg:border-t-0">
        <span className="label-mono">Demo source</span>
      </div>
      <div className="code-surface min-h-0 flex-1 overflow-auto px-[18px] py-4">
        <div className="pb-2.5 font-mono text-[11.5px] text-zinc-500">src/demo.tsx · {code ? note : cursor !== null && cursor <= 1 ? note : "not written"}</div>
        {code ? (
          <HighlightedCode key={codeEvent?.id ?? "page"} code={code} lineNumbers className="animate-rise -mx-2 bg-transparent text-[12.5px]" />
        ) : (
          <p className="font-mono text-xs text-zinc-500">{cursor !== null && cursor <= 1 ? "The demo appears here once it is written." : "No demo source in the log."}</p>
        )}
        {codeEvent?.stage === "repair" && previous && code && (
          <RepairDiff before={codeOf(previous)!} after={code} attempt={Number(codeEvent.detail.attempt ?? 1)} />
        )}
      </div>
    </div>
  )
}

// --- ページ

function BuildLogPage() {
  const d = Route.useLoaderData()
  const { events, loaded } = useLiveEvents({ componentId: d.id })
  const runs = splitRuns(events)
  const latest = runs.at(-1)

  // Replay: 直近の実行のイベントを 1 つずつ出し直す (届いたログを再生するだけ。サーバーには何もしない)
  const [reveal, setReveal] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (reveal === null || !latest) return
    if (reveal >= latest.events.length) {
      setReveal(null)
      return
    }
    const timer = setTimeout(() => setReveal(reveal + 1), 650)
    return () => clearTimeout(timer)
  }, [reveal, latest])
  const replaying = reveal !== null && latest !== undefined
  const run: RunView | undefined =
    latest && replaying
      ? { ...latest, events: latest.events.slice(0, Math.max(1, reveal)), endedAt: latest.events[Math.max(0, reveal - 1)]!.at, outcome: "running" }
      : latest

  const outcome: RunOutcome | "none" = run ? run.outcome : "none"
  const now = useNow(outcome === "running" && !replaying)
  const elapsed = run ? (outcome === "running" && !replaying ? now - run.startedAt : run.endedAt - run.startedAt) : null
  const steps = run ? stepsOf(run) : stepsFromStatus(d.status)
  const lines = run ? toLines(run) : []

  // 下端にいる間は新しい行に追従する
  const scroller = React.useRef<HTMLDivElement>(null)
  const [following, setFollowing] = React.useState(true)
  React.useEffect(() => {
    const el = scroller.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [lines.length, following])

  return (
    <div className="flex flex-col gap-8 pt-6">
      <div className="overflow-hidden rounded-[14px] border bg-card">
        {/* 上の帯 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b px-4 py-3.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              to="/c/$registryId/$name"
              params={{ registryId: d.registryId, name: d.name }}
              aria-label="Back to component"
              className="grid size-8 shrink-0 place-items-center rounded-lg border text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-[15px]" />
            </Link>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate font-mono text-sm font-medium">
                {d.registry.namespace ?? `@${d.registryId}`}/{d.name}
              </span>
              <span className="truncate font-mono text-[11.5px] text-faint">
                {run ? `run #${run.id} · started ${new Date(run.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" })}` : loaded ? "no build logged in the last 30 days" : "loading the log…"}
              </span>
            </div>
          </div>
          <StatusPill outcome={outcome} />
          <span className="grow" />
          {elapsed !== null && <span className="font-mono text-xs text-faint tabular-nums">elapsed {formatDuration(elapsed)}</span>}
          <button
            type="button"
            disabled={!latest || replaying}
            onClick={() => {
              setFollowing(true)
              setReveal(1)
            }}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <RotateCcw />
            Replay
          </button>
        </div>

        <div className="grid lg:h-[calc(100dvh-60px-170px)] lg:min-h-[560px] lg:grid-cols-[230px_minmax(0,1fr)_380px] xl:grid-cols-[260px_minmax(0,1fr)_440px]">
          {/* パイプライン */}
          <div className="flex flex-col gap-1 border-b px-[22px] py-6 lg:border-r lg:border-b-0">
            <span className="label-mono pb-3">Pipeline</span>
            <ol>
              {steps.map((s) => (
                <li key={s.stage} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-border/60 py-2.5 last:border-b-0">
                  <StepDot state={s.state} className="mt-1.5 size-2.5" />
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={cn("text-sm font-medium", s.state === "pending" || s.state === "skipped" ? "text-muted-foreground" : "text-foreground")}>
                      {s.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {s.state === "reused" || s.state === "skipped" || s.state === "failed" ? STEP_STATE_LABEL[s.state] : s.note ?? STEP_SUB[s.stage]}
                    </span>
                  </div>
                  <span className="mt-0.5 font-mono text-[11.5px] text-faint tabular-nums">
                    {s.state === "current" ? "…" : s.durationMs !== null ? formatDuration(s.durationMs) : ""}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-auto pt-4 text-xs leading-normal text-faint">Public log. Prompts, raw model errors and costs stay on the admin side.</p>
          </div>

          {/* ログ */}
          <div className="code-surface flex min-h-0 min-w-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-zinc-800/80 px-[18px]">
              <span className="font-mono text-[11px] tracking-[0.08em] text-zinc-400 uppercase">Log</span>
              <span className="grow" />
              {outcome === "running" && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                  {following ? <SignalDot /> : <span className="size-[7px] rounded-full border border-zinc-500" />}
                  {replaying ? "replaying" : following ? "following" : "paused · scroll down to follow"}
                </span>
              )}
            </div>
            <div
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget
                setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
              }}
              className="flex max-h-[60vh] min-h-[280px] flex-1 flex-col overflow-auto px-[18px] py-3.5 font-mono text-[12.5px] leading-loose lg:max-h-none"
            >
              <div className="mt-auto">
                {!loaded ? (
                  <div className="flex flex-col gap-3 py-2">
                    {[60, 80, 45].map((w) => (
                      <div key={w} className="h-3 rounded bg-zinc-800/70" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                ) : lines.length === 0 ? (
                  <p className="text-zinc-500">No build has been logged for this component in the last 30 days.</p>
                ) : (
                  <LogLines lines={lines} animate />
                )}
                {outcome === "running" && (
                  <div className="pl-[124px] sm:pl-[142px]">
                    <span className="inline-block h-3.5 w-[7px] translate-y-0.5 animate-caret bg-signal" />
                  </div>
                )}
              </div>
            </div>
          </div>

          <SidePanel d={d} run={run} allEvents={events} replaying={replaying} />
        </div>
      </div>

      {runs.length > 1 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold tracking-[-0.02em]">Earlier runs</h2>
          <div className="flex flex-col divide-y rounded-[14px] border bg-card">
            {runs
              .slice(0, -1)
              .reverse()
              .map((r) => (
                <details key={r.id} className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                    <span className="font-mono text-xs">run #{r.id}</span>
                    <span className="truncate text-muted-foreground">
                      {new Date(r.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                    <span className="grow" />
                    <StatusPill outcome={r.outcome} />
                    <span className="hidden font-mono text-xs text-faint tabular-nums sm:inline">{formatDuration(r.endedAt - r.startedAt)}</span>
                  </summary>
                  <div className="code-surface overflow-x-auto px-[18px] py-3 font-mono text-[12.5px] leading-loose">
                    <LogLines lines={toLines(r)} animate={false} />
                  </div>
                </details>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}

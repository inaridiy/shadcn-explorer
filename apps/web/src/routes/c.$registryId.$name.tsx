import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowRight, Bot, Check, Copy, ExternalLink, FileCode2, Loader2, TriangleAlert } from "lucide-react"
import * as React from "react"
import { STEP_STATE_LABEL, StepDot } from "~/components/build-steps"
import { CodeBlock, CommandLine, HighlightedCode } from "~/components/code-block"
import { ComponentCard } from "~/components/component-card"
import { CopyButton } from "~/components/copy-button"
import { ListingBadge, SignalDot } from "~/components/listing-badge"
import { LivePreview } from "~/components/live-preview"
import { Badge } from "~/components/ui/badge"
import { buttonVariants } from "~/components/ui/button"
import { type RunView, type StepView, formatDuration, splitRuns, stepsFromStatus, stepsOf } from "~/lib/build-run"
import { previewReportUrl, themeReportUrl } from "~/lib/links"
import { useLiveEvents } from "~/lib/live"
import { cn } from "~/lib/utils"
import { getComponentFn, similarComponentsFn } from "~/server/components"
import { type ComponentCardDto, type ComponentDetailDto, type RegistryDto, toAgentMarkdown } from "~/server/dto"

export const Route = createFileRoute("/c/$registryId/$name")({
  loader: ({ params }) => getComponentFn({ data: params }),
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [{ title: `${loaderData.title} · ${loaderData.registryId} — Shadcn Explorer` }, { name: "description", content: loaderData.doc?.summary ?? loaderData.description }]
      : [],
  }),
  component: ComponentPage,
})

const WORKAROUND_LABELS: Array<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [/^sibling-item:(.+)$/, (m) => `installed sibling item "${m[1]}" that the item imports but does not declare`],
  [/^namespaced-dependency:(.+)$/, (m) => `resolved dependency "${m[1]}" from the item's own registry`],
  [/^undeclared-dependency:(.+)$/, (m) => `installed npm package ${m[1]}, which the item uses but does not declare`],
  [/^registry-theme$/, () => "applied the registry's theme (tokens, fonts and CSS from the registry preview settings)"],
  [/^registry-base:(.+)$/, (m) => `installed base item ${m[1]} (registry preview settings)`],
  [/^registry-base-failed:(.+)$/, (m) => `could not install the registry's theme item ${m[1]}; built with the default theme`],
  [/^registry-pin:(.+)$/, (m) => `pinned ${m[1]} (registry preview settings)`],
  [/^pin:(.+)$/, (m) => `pinned ${m[1]}`],
  [/^add:(.+)$/, (m) => `added npm package ${m[1]}`],
  [/^item:(.+)$/, (m) => `added registry item ${m[1]}`],
  [/^file:(.+)$/, (m) => `added compat file ${m[1]}`],
  [/^alias:(.+)$/, (m) => `redirected import ${m[1]} to a compat file`],
  [/^wrap:(.+)$/, (m) => `wrapped the demo in provider ${m[1]}`],
]
const describeWorkaround = (w: string) => {
  for (const [re, label] of WORKAROUND_LABELS) {
    const m = w.match(re)
    if (m) return label(m)
  }
  return w
}

/** テーマの出所を 1 句にする (プレビューの由来の行と Registry カードで使う) */
const themeSourceLabel = (theme: RegistryDto["theme"]): string => {
  switch (theme._tag) {
    case "Resolved":
      return theme.source === "registry-item"
        ? "from registry.json"
        : theme.source === "agent"
          ? "from the install docs"
          : theme.source === "manual"
            ? "set by the maintainer"
            : "neutral (none shipped)"
    case "Unresolved":
      return "not detected yet"
    case "AgentPending":
      return "an agent is reading the install docs"
    case "Proposed":
      return "guess awaiting review · neutral for now"
    case "Failed":
      return "detection failed · neutral"
  }
}

// --- パッケージマネージャ (選択はこのブラウザに覚える)

const PMS = [
  { id: "pnpm", run: "pnpm dlx" },
  { id: "npm", run: "npx" },
  { id: "bun", run: "bunx --bun" },
  { id: "yarn", run: "yarn dlx" },
] as const
type PmId = (typeof PMS)[number]["id"]

const commandFor = (installCommand: string, pm: PmId) =>
  installCommand.replace(/^npx /, `${PMS.find((p) => p.id === pm)!.run} `)

const usePackageManager = () => {
  const [pm, setPm] = React.useState<PmId>("pnpm")
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem("package-manager")
      if (stored && PMS.some((p) => p.id === stored)) setPm(stored as PmId)
    } catch {}
  }, [])
  const choose = (next: PmId) => {
    setPm(next)
    try {
      localStorage.setItem("package-manager", next)
    } catch {}
  }
  return [pm, choose] as const
}

/** SSR では分からない値 (サイトの origin・今のページの URL) を表示後に入れる */
const useOrigin = () => {
  const [origin, setOrigin] = React.useState<string | null>(null)
  React.useEffect(() => setOrigin(window.location.origin), [])
  return origin
}

// --- 小さな部品

function CopyAction({ value, label, icon, primary = false }: { value: string; label: string; icon: React.ReactNode; primary?: boolean }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <button
      type="button"
      className={cn(buttonVariants({ variant: primary ? "default" : "outline", size: "sm" }), "h-9 px-3.5")}
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check /> : icon}
      {copied ? "Copied" : label}
    </button>
  )
}

function Section({ id, title, aside, children }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-[-0.02em]">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function RailCard({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="label-mono">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

const GithubIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="size-[15px] shrink-0" aria-hidden>
    <path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1 1.6 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z" />
  </svg>
)

// --- プレビュー

/** プレビューがどう作られたか (素の shadcn add からの逸脱) と、作れなかった理由を正直に出す */
function PreviewProvenance({ d }: { d: ComponentDetailDto }) {
  const buildLink = (
    <Link
      to="/c/$registryId/$name/build"
      params={{ registryId: d.registryId, name: d.name }}
      className="inline-flex shrink-0 items-center gap-1.5 text-foreground/85 hover:text-foreground"
    >
      See how it was built <ArrowRight className="size-3" />
    </Link>
  )
  const theme = `theme ${themeSourceLabel(d.registry.theme)}`
  let icon: React.ReactNode = <Check className="mt-0.5 size-3.5 shrink-0 text-foreground/85" />
  let body: React.ReactNode
  if (d.previewFailure) {
    icon = <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
    body =
      d.previewFailure.cause === "registry"
        ? `This item cannot be built as published, so there is no live preview: ${d.previewFailure.message}`
        : "A live preview is not available for this item yet."
  } else if (!d.previewBuild) {
    const noPreview = ["hook", "lib", "file"].includes(d.kind)
    icon = noPreview ? <FileCode2 className="mt-0.5 size-3.5 shrink-0" /> : <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
    body = noPreview ? `A ${d.kind} has nothing to render, so there is no live preview.` : "The live preview has not been built yet."
  } else if (d.previewBuild.workarounds.length === 0) {
    body = (
      <span>
        Installed with plain <code className="font-mono text-foreground/85">shadcn add</code> · no workarounds · {theme}
        {d.previewBuild.kind === "agent" ? " · recipe written by a coding agent" : ""}
      </span>
    )
  } else {
    const n = d.previewBuild.workarounds.length
    body = (
      <details className="group">
        <summary className="cursor-pointer list-none marker:hidden [&::-webkit-details-marker]:hidden">
          Installed with <code className="font-mono text-foreground/85">shadcn add</code> ·{" "}
          <span className="underline decoration-dotted underline-offset-4 group-open:no-underline">
            {n} workaround{n > 1 ? "s" : ""}
          </span>
          {d.previewBuild.kind === "agent" ? " (recipe written by a coding agent)" : ""} · {theme}
        </summary>
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {d.previewBuild.workarounds.map((w) => (
            <li key={w}>{describeWorkaround(w)}</li>
          ))}
        </ul>
      </details>
    )
  }
  return (
    <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1.5 border-t px-3.5 py-2.5 text-[12.5px] text-muted-foreground">
      {icon}
      <div className="min-w-0 flex-1 basis-60">{body}</div>
      {buildLink}
    </div>
  )
}

function PreviewBlock({ d }: { d: ComponentDetailDto }) {
  const code = d.demoCode ?? d.doc?.examples[0]?.code ?? null
  const [tab, setTab] = React.useState<"preview" | "code">("preview")
  const tabClass = (active: boolean) =>
    cn(
      "h-[34px] rounded-[7px] px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-signal",
      active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
    )
  const tabs = (
    <div role="tablist" className="flex gap-0.5">
      <button type="button" role="tab" aria-selected={tab === "preview"} onClick={() => setTab("preview")} className={tabClass(tab === "preview")}>
        Preview
      </button>
      {code !== null && (
        <button type="button" role="tab" aria-selected={tab === "code"} onClick={() => setTab("code")} className={tabClass(tab === "code")}>
          Code
        </button>
      )}
    </div>
  )
  const codeView =
    tab === "code" && code !== null ? (
      <div className="code-surface">
        <div className="flex items-center justify-between gap-3 px-5 pt-3 pb-1">
          <span className="truncate font-mono text-xs text-zinc-400">
            {d.demoCode ? "src/demo.tsx · the exact file we built" : "example.tsx · from the generated docs"}
          </span>
          <CopyButton value={code} className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" />
        </div>
        <HighlightedCode code={code} lineNumbers className="max-h-[560px] px-2 pt-2 pb-5" />
      </div>
    ) : null
  return (
    <LivePreview
      src={d.previewHtmlUrl}
      card={d}
      layout={d.previewLayout}
      themes={{ registry: d.registry.previewConfig.tokens ?? null, variants: d.registry.previewConfig.variants ?? [] }}
      tabs={tabs}
      codeView={codeView}
      footer={<PreviewProvenance d={d} />}
    />
  )
}

// --- 本文

function Installation({ d, pm, setPm }: { d: ComponentDetailDto; pm: PmId; setPm: (pm: PmId) => void }) {
  const command = commandFor(d.installCommand, pm)
  return (
    <Section id="installation" title="Installation">
      <div className="code-surface overflow-hidden rounded-xl border border-zinc-800">
        <div role="tablist" className="flex gap-0.5 border-b border-zinc-800/80 p-1.5">
          {PMS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pm === p.id}
              onClick={() => setPm(p.id)}
              className={cn(
                "h-7 rounded-md px-2.5 font-mono text-xs transition-colors focus-visible:outline-2 focus-visible:outline-signal",
                pm === p.id ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-100",
              )}
            >
              {p.id}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 py-3 pr-3 pl-4">
          <div className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap">
            <CommandLine command={command} />
          </div>
          <CopyButton value={command} className="border border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" />
        </div>
      </div>
      {d.registry.namespace && (
        <p className="text-sm text-muted-foreground">
          Requires <code className="font-mono text-foreground/85">{d.registry.namespace}</code> in the{" "}
          <code className="font-mono text-foreground/85">registries</code> of your components.json (shadcn adds official directory namespaces
          automatically).
        </p>
      )}
    </Section>
  )
}

function PropsTable({ props }: { props: NonNullable<ComponentDetailDto["doc"]>["props"] }) {
  const cols = "grid grid-cols-[minmax(110px,160px)_minmax(140px,200px)_minmax(64px,100px)_minmax(200px,1fr)] gap-4"
  return (
    <div className="overflow-x-auto rounded-xl border">
      <div className="min-w-[620px]">
        <div className={cn(cols, "label-mono bg-muted px-4 py-2.5")}>
          <span>Prop</span>
          <span>Type</span>
          <span>Default</span>
          <span>Description</span>
        </div>
        {props.map((p) => (
          <div key={p.name} className={cn(cols, "border-t px-4 py-3 text-[13.5px]")}>
            <span className="font-mono break-all">{p.name}</span>
            <span className="font-mono text-[12.5px] break-words text-sky-700 dark:text-sky-300">{p.type}</span>
            <span className="font-mono text-[12.5px] text-muted-foreground">{p.default ?? "—"}</span>
            <span className="text-foreground/85">{p.description}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 「よそで似ているもの」。表示してから取りに行く (SSR を待たせない) */
function SimilarElsewhere({ d }: { d: ComponentDetailDto }) {
  const [cards, setCards] = React.useState<ReadonlyArray<ComponentCardDto> | null>(null)
  const hasShot = d.screenshot !== null
  React.useEffect(() => {
    if (!hasShot) return
    let stopped = false
    setCards(null)
    similarComponentsFn({ data: { registryId: d.registryId, name: d.name } })
      .then((found) => !stopped && setCards(found))
      .catch(() => !stopped && setCards([]))
    return () => {
      stopped = true
    }
  }, [d.registryId, d.name, hasShot])
  const registries = cards ? new Set(cards.map((c) => c.registryId)).size : 0
  return (
    <Section
      id="similar"
      title="Looks similar, elsewhere"
      aside={
        cards && cards.length > 0 ? (
          <span className="font-mono text-xs text-faint">
            nearest screenshots · {registries} registr{registries === 1 ? "y" : "ies"}
          </span>
        ) : null
      }
    >
      {!hasShot ? (
        <p className="text-sm text-muted-foreground">There is no screenshot of this item to compare yet.</p>
      ) : cards === null ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="overflow-hidden rounded-[14px] border">
              <div className="skeleton aspect-[16/10]" />
              <div className="flex flex-col gap-2 p-3">
                <div className="skeleton h-3 w-2/3 rounded" />
                <div className="skeleton h-2.5 w-1/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing in other registries looks close to this one yet.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {cards.slice(0, 8).map((c) => (
            <ComponentCard key={c.id} card={c} />
          ))}
        </div>
      )}
    </Section>
  )
}

// --- 右の列

const DONE_LABEL: Record<StepView["stage"], string> = {
  docs: "Docs written",
  demo: "Demo written",
  build: "Built",
  capture: "Captured",
  index: "Indexed",
}

function BuildCard({ d, run }: { d: ComponentDetailDto; run: RunView | undefined }) {
  const steps = run ? stepsOf(run) : stepsFromStatus(d.status)
  const running = run?.outcome === "running"
  return (
    <RailCard
      label="Build"
      aside={
        run ? (
          running ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-signal-foreground">
              <SignalDot pulse />
              building
            </span>
          ) : (
            <span className="font-mono text-[11px] text-faint">
              {new Date(run.startedAt).toISOString().slice(0, 10)} · {formatDuration(run.endedAt - run.startedAt)} total
            </span>
          )
        ) : null
      }
    >
      <ol className="flex flex-col">
        {steps.map((s) => {
          const note =
            s.state === "reused"
              ? "reused"
              : s.state === "failed"
                ? "failed"
                : s.state === "current"
                  ? "running…"
                  : s.state === "skipped"
                    ? "not in this run"
                    : s.note
          return (
            <li key={s.stage} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2.5 py-1.5" title={STEP_STATE_LABEL[s.state]}>
              <StepDot state={s.state} />
              <span className={cn("truncate text-[13px]", s.state === "pending" || s.state === "skipped" ? "text-muted-foreground" : "text-foreground/85")}>
                {s.state === "done" ? DONE_LABEL[s.stage] : s.label}
                {note && <span className={cn("ml-1.5", s.state === "current" ? "text-signal-foreground" : "text-muted-foreground")}>{note}</span>}
              </span>
              <span className="font-mono text-[11.5px] text-faint">{s.durationMs !== null ? formatDuration(s.durationMs) : ""}</span>
            </li>
          )
        })}
      </ol>
      <Link
        to="/c/$registryId/$name/build"
        params={{ registryId: d.registryId, name: d.name }}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-full")}
      >
        {running && <SignalDot pulse />}
        {running ? "Watch the build" : "Open build log"}
      </Link>
    </RailCard>
  )
}

/** 同期の間隔 (cron の resyncIntervalMs と同じ 7 日) */
const RESYNC_INTERVAL_MS = 7 * 86_400_000

const daysPhrase = (ms: number) => {
  const days = Math.round(ms / 86_400_000)
  if (days <= 0) return "today"
  return `${days} day${days > 1 ? "s" : ""}`
}

const syncLine = (status: RegistryDto["status"], now: number) => {
  switch (status._tag) {
    case "Pending":
      return "Not synced yet"
    case "Syncing":
      return "Syncing now"
    case "Disabled":
      return "Sync disabled"
    case "Failed":
      return `Last sync failed ${daysPhrase(now - status.failedAt) === "today" ? "today" : `${daysPhrase(now - status.failedAt)} ago`}`
    case "Active": {
      const ago = daysPhrase(now - status.lastSyncedAt)
      const next = status.lastSyncedAt + RESYNC_INTERVAL_MS - now
      return `Synced ${ago === "today" ? "today" : `${ago} ago`} · ${next > 0 ? `next in ${daysPhrase(next)}` : "next sync due"}`
    }
  }
}

function RegistryCard({ d }: { d: ComponentDetailDto }) {
  const r = d.registry
  const count = r.status._tag === "Active" ? r.status.itemCount : null
  const tokens = r.previewConfig.tokens?.light
  const swatches = tokens ? (["--background", "--foreground", "--primary"] as const).map((k) => tokens[k]).filter((v): v is string => Boolean(v)) : []
  return (
    <RailCard label="Registry" aside={<ListingBadge listing={d.listing} />}>
      <Link to="/registries/$registryId" params={{ registryId: r.id }} className="group flex items-center justify-between gap-3">
        <span className="truncate font-mono text-sm font-medium group-hover:text-signal-foreground">{r.namespace ?? `@${r.id}`}</span>
        {count !== null && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {count} component{count === 1 ? "" : "s"}
          </span>
        )}
      </Link>
      <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        {swatches.length > 0 && (
          <span className="flex">
            {swatches.map((c, i) => (
              <span key={`${c}-${i}`} className={cn("size-3.5 rounded-[4px] border", i > 0 && "-ml-1")} style={{ background: c }} />
            ))}
          </span>
        )}
        <span>Theme: {themeSourceLabel(r.theme)}</span>
      </div>
      <span className="text-[12.5px] text-muted-foreground" suppressHydrationWarning>
        {syncLine(r.status, Date.now())}
      </span>
    </RailCard>
  )
}

function ReportCard({ d, run }: { d: ComponentDetailDto; run: RunView | undefined }) {
  const origin = useOrigin()
  const pageUrl = origin ? `${origin}/c/${d.registryId}/${d.name}` : undefined
  const links = [
    {
      label: "Preview looks broken",
      href: previewReportUrl({ registryId: d.registryId, name: d.name, ...(pageUrl ? { pageUrl } : {}), ...(run ? { build: `run #${run.id}` } : {}) }),
    },
    {
      label: "Theme doesn’t match the registry",
      href: themeReportUrl({ registry: d.registryId, ...(pageUrl ? { pageUrl } : {}), detected: themeSourceLabel(d.registry.theme) }),
    },
  ]
  return (
    <RailCard label="Something off?">
      <div className="flex flex-col gap-2.5">
        {links.map((l) => (
          <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="flex items-center gap-2.5 text-[13px] text-foreground/85 hover:text-foreground">
            <GithubIcon />
            {l.label}
          </a>
        ))}
      </div>
      <span className="text-xs leading-normal text-faint">Opens a GitHub issue, prefilled with this component and its build id.</span>
    </RailCard>
  )
}

function McpCard() {
  const origin = useOrigin()
  const url = `${origin ?? "https://…"}/mcp`
  // シェルのコマンドは sugar-high だと URL の // がコメントになるので、自前で色を付ける
  return (
    <RailCard label="Use from your agent" aside={<CopyButton value={`claude mcp add --transport http shadcn-explorer ${url}`} className="-my-1 size-6" />}>
      <pre className="code-surface overflow-x-auto rounded-lg px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-zinc-300">
        <span className="text-fuchsia-300">claude</span> mcp add <span className="text-amber-300">--transport</span> http \{"\n"}
        {"  "}shadcn-explorer <span className="text-lime-200">{url}</span>
      </pre>
      <Link to="/settings" className="text-xs text-muted-foreground hover:text-foreground">
        API keys and other clients →
      </Link>
    </RailCard>
  )
}

// --- ページ

function ComponentPage() {
  const d = Route.useLoaderData()
  const [pm, setPm] = usePackageManager()
  // 直近の実行 (Build カードと不具合報告のビルド ID で使う)。ビルド中なら増分で追い続ける
  const { events } = useLiveEvents({ componentId: d.id })
  const run = splitRuns(events).at(-1)

  return (
    <div className="grid gap-10 pt-7 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
      <article className="flex min-w-0 flex-col gap-9">
        <header className="flex flex-col gap-3.5">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
            <Link to="/" className="hover:text-foreground">
              explore
            </Link>
            <span>/</span>
            <Link to="/registries/$registryId" params={{ registryId: d.registryId }} className="truncate text-foreground/85 hover:text-foreground">
              {d.registry.namespace ?? `@${d.registryId}`}
            </Link>
            <ListingBadge listing={d.listing} className="h-[18px] text-[9.5px]" />
            <span>/</span>
            <span className="truncate text-foreground">{d.name}</span>
          </nav>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="flex min-w-0 flex-col gap-2.5">
              <h1 className="text-[32px] leading-[1.1] font-semibold tracking-[-0.04em] sm:text-4xl">{d.title}</h1>
              <p className="max-w-[640px] text-base leading-relaxed text-muted-foreground">{d.doc?.summary ?? d.description}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <CopyAction value={d.agentPrompt} label="Copy for agent" icon={<Bot />} />
              <CopyAction value={commandFor(d.installCommand, pm)} label="Copy install" icon={<Copy />} primary />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="kind">{d.kind}</Badge>
            {d.categories.map((c) => (
              <Badge key={c} variant="kind">
                {c}
              </Badge>
            ))}
            <a
              href={d.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-1 inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
            >
              registry-item.json <ExternalLink className="size-3" />
            </a>
          </div>
          {d.safetyFlags.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              Suspicious content detected in this registry item ({d.safetyFlags.join(", ")}). Review the source before installing.
            </div>
          )}
          {d.status.doc !== "Generated" && (
            <div className="flex items-start gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              {d.docError
                ? `Usage docs could not be generated: ${d.docError}`
                : "Usage docs and preview are being generated by the coding agent. Registry metadata is shown meanwhile."}
            </div>
          )}
        </header>

        <PreviewBlock d={d} />

        <Installation d={d} pm={pm} setPm={setPm} />

        {d.doc && (
          <>
            <Section id="usage" title="Usage">
              <CodeBlock code={d.doc.usage} title="usage.tsx" />
              {d.doc.whenToUse.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {d.doc.whenToUse.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </Section>
            {d.doc.examples.length > 0 && (
              <Section id="examples" title="Examples">
                {d.doc.examples.map((ex) => (
                  <div key={ex.title} className="flex flex-col gap-2">
                    <h3 className="font-medium">{ex.title}</h3>
                    {ex.description && <p className="text-sm text-muted-foreground">{ex.description}</p>}
                    <CodeBlock code={ex.code} title={`${ex.title.toLowerCase().replace(/\s+/g, "-")}.tsx`} />
                  </div>
                ))}
              </Section>
            )}
            {d.doc.props.length > 0 && (
              <Section id="props" title="API reference">
                <PropsTable props={d.doc.props} />
              </Section>
            )}
            {d.doc.accessibility.length > 0 && (
              <Section id="a11y" title="Accessibility">
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {d.doc.accessibility.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Section>
            )}
            {d.docModel && <p className="-mt-4 font-mono text-[11px] text-faint">Docs written by {d.docModel} from the registry source.</p>}
          </>
        )}

        <Section id="agent" title="Use with Coding Agent">
          <p className="text-sm text-muted-foreground">
            Paste this into Claude Code, Codex or Cursor. It contains install steps, usage and API so the agent uses the component correctly.
          </p>
          <div className="flex flex-wrap gap-2">
            <CopyButton value={toAgentMarkdown(d)} label="Copy docs as Markdown" />
            <CopyButton value={d.agentPrompt} label="Copy agent prompt" />
          </div>
          <CodeBlock code={d.agentPrompt} title="prompt.md" lineNumbers={false} />
        </Section>

        <Section id="files" title="Files & dependencies">
          <ul className="flex flex-col divide-y rounded-xl border">
            {d.files.map((f) => (
              <li key={f.path} className="flex min-w-0 items-center gap-2.5 px-4 py-2.5 font-mono text-xs">
                <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.path}</span>
                {f.target && <span className="truncate text-muted-foreground">→ {f.target}</span>}
              </li>
            ))}
          </ul>
          {[
            { label: "dependencies", items: d.dependencies },
            { label: "devDependencies", items: d.devDependencies },
            { label: "registryDependencies", items: d.registryDependencies },
          ]
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <div key={g.label} className="flex flex-wrap items-center gap-1.5">
                <span className="label-mono mr-1">{g.label}</span>
                {g.items.map((dep) => (
                  <Badge key={dep} variant="kind">
                    {dep}
                  </Badge>
                ))}
              </div>
            ))}
          {d.related.length > 0 && (
            <div className="flex flex-col gap-2 pt-2">
              <span className="label-mono">Uses from {d.registry.namespace ?? `@${d.registryId}`}</span>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {d.related.map((r) => (
                  <ComponentCard key={r.id} card={r} />
                ))}
              </div>
            </div>
          )}
        </Section>

        <SimilarElsewhere d={d} />
      </article>

      <aside className="flex flex-col gap-4 self-start lg:sticky lg:top-[84px]">
        <BuildCard d={d} run={run} />
        <RegistryCard d={d} />
        <ReportCard d={d} run={run} />
        <McpCard />
      </aside>
    </div>
  )
}

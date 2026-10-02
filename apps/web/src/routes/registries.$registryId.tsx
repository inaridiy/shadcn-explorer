import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { ArrowUpRight, Loader2, RefreshCw } from "lucide-react"
import * as React from "react"
import { CommandLine } from "~/components/code-block"
import { ComponentCard } from "~/components/component-card"
import { CopyButton } from "~/components/copy-button"
import { ListingBadge, SignalDot, listingOf } from "~/components/listing-badge"
import { RegistryPreviewSettings } from "~/components/registry-preview-settings"
import { RegistryThemePanel } from "~/components/registry-theme-panel"
import { Button } from "~/components/ui/button"
import { previewReportUrl, themeReportUrl } from "~/lib/links"
import { type LiveEvent, splitComponentId, timeAgo, useLiveEvents, useLiveSummary } from "~/lib/live"
import { NEUTRAL_TOKENS, SWATCH_TOKENS, type ThemeTokensDto } from "~/lib/theme"
import { cn } from "~/lib/utils"
import type { ComponentCardDto, RegistryDto } from "~/server/dto"
import { getRegistryFn, resyncRegistryFn } from "~/server/registries"

type Tab = "components" | "log" | "missing"
const TABS: ReadonlyArray<Tab> = ["components", "log", "missing"]

export const Route = createFileRoute("/registries/$registryId")({
  validateSearch: (input: Record<string, unknown>): { tab?: Tab } =>
    TABS.includes(input.tab as Tab) && input.tab !== "components" ? { tab: input.tab as Tab } : {},
  loader: ({ params }) => getRegistryFn({ data: { registryId: params.registryId } }),
  component: RegistryPage,
})

/** 再同期の間隔 (サーバーの RESYNC_INTERVAL_DAYS の既定)。古い順に夜ごと分散して回るので「次」は目安 */
const SYNC_INTERVAL_MS = 7 * 24 * 3600 * 1000
/** 見た目を持たない種別 (プレビューを作らない) */
const CODE_ONLY = new Set<string>(["hook", "lib", "file"])

type PreviewBucket = "live" | "building" | "missing" | "code"

/** カードのプレビューの状態を 4 つに分ける (Screenshot の「building preview…」と同じ判定) */
const bucketOf = (card: ComponentCardDto): PreviewBucket => {
  if (card.screenshot) return "live"
  if (CODE_ONLY.has(card.kind)) return "code"
  if ((card.status.preview === "NotCaptured" || card.status.preview === "Built") && card.status.doc !== "Failed") return "building"
  return "missing"
}

function RegistryPage() {
  const { registry, components } = Route.useLoaderData()
  const { tab = "components" } = Route.useSearch()
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const inProgress =
    registry.status._tag === "Pending" || registry.status._tag === "Syncing" || components.some((c) => c.status.index === "NotIndexed")

  // 同期・エンリッチ中は定期的に再取得して進捗を見せる
  React.useEffect(() => {
    if (!inProgress) return
    const t = setInterval(() => router.invalidate(), 5000)
    return () => clearInterval(t)
  }, [inProgress, router])

  const buckets = React.useMemo(() => {
    const by: Record<PreviewBucket, Array<ComponentCardDto>> = { live: [], building: [], missing: [], code: [] }
    for (const c of components) by[bucketOf(c)].push(c)
    return by
  }, [components])
  const motion = buckets.live.filter((c) => c.screenshot?.motion).length

  // カードから数えられるものだけ出す (無いものは出さない)
  const stats: ReadonlyArray<{ k: string; v: number; tone?: "signal" | "muted" }> = [
    { k: "components", v: components.length },
    { k: "live demos", v: buckets.live.length },
    motion > 0 ? { k: "with motion", v: motion, tone: "signal" as const } : { k: "with motion", v: motion },
    ...(buckets.building.length > 0 ? [{ k: "building", v: buckets.building.length, tone: "signal" as const }] : []),
    { k: "no preview", v: buckets.missing.length },
    { k: "hooks / libs", v: buckets.code.length, tone: "muted" as const },
  ]

  return (
    <div className="flex flex-col">
      <Hero registry={registry} stats={stats} isAdmin={user?.isAdmin === true} />
      <div className="grid gap-9 pt-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4.5">
          <nav className="flex gap-1 overflow-x-auto border-b [scrollbar-width:none]" aria-label="Registry sections">
            <TabLink tab="components" current={tab} count={components.length}>
              Components
            </TabLink>
            <TabLink tab="log" current={tab}>
              Build log
            </TabLink>
            <TabLink tab="missing" current={tab} count={buckets.missing.length}>
              No preview
            </TabLink>
          </nav>
          {tab === "components" &&
            (components.length === 0 ? (
              <EmptyStage
                title={registry.status._tag === "Failed" ? "Sync failed" : "Nothing here yet"}
                body={
                  registry.status._tag === "Failed"
                    ? registry.status.reason
                    : "Items appear as soon as the first sync reads registry.json."
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
                {components.map((c) => (
                  <ComponentCard key={c.id} card={c} />
                ))}
              </div>
            ))}
          {tab === "log" && <BuildLog registryId={registry.id} />}
          {tab === "missing" && <NoPreview registryId={registry.id} cards={buckets.missing} />}

          {/* 再同期・テーマの承認・プレビュー設定は運営者だけ */}
          {user?.isAdmin && (
            <section className="mt-6 flex flex-col gap-3 border-t pt-6">
              <span className="label-mono">Operator</span>
              <RegistryThemePanel registry={registry} />
              <RegistryPreviewSettings registry={registry} />
            </section>
          )}
        </div>
        <aside className="flex flex-col gap-4">
          <ThemeCard registry={registry} />
          <SyncCard registry={registry} />
          <RecentBuilds registryId={registry.id} />
        </aside>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ヒーロー (ドットグリッドの上)
// ---------------------------------------------------------------------------

const LISTING_NOTE: Record<string, string> = {
  Official: "Listed in the shadcn registry directory · imported automatically",
  Shadcn: "The shadcn/ui registry itself",
  Community: "Added on request · not in the official directory",
}

function Hero({
  registry,
  stats,
  isAdmin,
}: {
  registry: RegistryDto
  stats: ReadonlyArray<{ k: string; v: number; tone?: "signal" | "muted" }>
  isAdmin: boolean
}) {
  const listing = listingOf(registry.listing)
  const delisted = registry.listing._tag === "Official" && !registry.listing.listed
  const title = registry.namespace ?? registry.name
  const command = registry.namespace ? `npx shadcn@latest add ${registry.namespace}/<name>` : "npx shadcn@latest add <item-url>"
  const host = registry.homepage ? hostOf(registry.homepage) : null
  return (
    // 帯は画面の端まで: 色は box-shadow で横に伸ばし (スクロール幅を増やさない)、下端の線も同じ方法で引く
    <section className="stage relative -mx-4 px-4 shadow-[0_0_0_100vmax_var(--stage)] [clip-path:inset(0_-100vmax)] sm:-mx-8 sm:px-8">
      <div className="flex flex-col gap-7 pt-9 pb-8 sm:pt-11 sm:pb-9">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end lg:gap-8">
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <ListingBadge listing={listing} />
              <span className="text-[12.5px] text-muted-foreground">
                {delisted ? "No longer listed in the shadcn registry directory" : LISTING_NOTE[listing]}
              </span>
            </div>
            <h1 className="truncate font-mono text-[32px] leading-none font-medium tracking-[-0.04em] sm:text-[44px]">{title}</h1>
            {registry.namespace && registry.name !== registry.namespace.replace(/^@/, "") && (
              <p className="max-w-[620px] text-[15px] leading-relaxed text-muted-foreground">{registry.name}</p>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
              {registry.homepage && (
                <a href={registry.homepage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground">
                  {host} <ArrowUpRight className="size-3.5" />
                </a>
              )}
              <a href={registry.indexUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground">
                registry.json <ArrowUpRight className="size-3.5" />
              </a>
              {isAdmin && <ResyncButton registryId={registry.id} />}
            </div>
          </div>
          <div className="flex w-full flex-col gap-2 rounded-xl border border-zinc-800 bg-code px-4 py-3.5 lg:w-[440px] lg:shrink-0">
            <div className="flex items-center justify-between">
              <span className="label-mono text-zinc-400">Add any item</span>
              <CopyButton value={command} className="-my-1.5 -mr-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" />
            </div>
            <div className="overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
              <CommandLine command={command} />
            </div>
          </div>
        </div>
        {/* 折り返した最後の行は残りの幅を埋める (空のセルを作らない) */}
        <div className="flex flex-wrap overflow-hidden rounded-[14px] border bg-card">
          {stats.map((s) => (
            <div key={s.k} className="-mr-px -mb-px flex min-w-[45%] flex-1 flex-col gap-1 border-r border-b px-4.5 py-4 sm:min-w-[30%] lg:min-w-0">
              <span
                className={cn(
                  "font-mono text-2xl font-medium tracking-[-0.03em] tabular-nums",
                  s.tone === "signal" && "text-signal-foreground",
                  s.tone === "muted" && "text-muted-foreground",
                )}
              >
                {s.v.toLocaleString("en-US")}
              </span>
              <span className="label-mono">{s.k}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-px bg-border shadow-[0_0_0_100vmax_var(--border)] [clip-path:inset(0_-100vmax)]" />
    </section>
  )
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url)
    // github.com だけでは分からないので、パスも付ける
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`
  } catch {
    return url
  }
}

function ResyncButton({ registryId }: { registryId: string }) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={async () => {
          setPending(true)
          try {
            await resyncRegistryFn({ data: { registryId } })
            setMessage("Re-sync scheduled")
            await router.invalidate()
          } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e))
          } finally {
            setPending(false)
          }
        }}
      >
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-sync
      </Button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </span>
  )
}

function TabLink({ tab, current, count, children }: { tab: Tab; current: Tab; count?: number; children: React.ReactNode }) {
  const active = tab === current
  return (
    <Link
      from="/registries/$registryId"
      search={tab === "components" ? {} : { tab }}
      replace
      resetScroll={false}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-10 shrink-0 items-center px-3 text-sm transition-colors",
        active ? "font-medium text-foreground shadow-[inset_0_-2px_0_var(--signal)]" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined && <span className="ml-1.5 font-mono text-[11px] text-faint">{count}</span>}
    </Link>
  )
}

function EmptyStage({ title, body, live = false }: { title: string; body: string; live?: boolean }) {
  return (
    <div className="stage flex flex-col items-center justify-center gap-2 rounded-[14px] border px-6 py-16 text-center">
      <span className="inline-flex items-center gap-2 text-sm font-medium">
        {live && <SignalDot pulse />}
        {title}
      </span>
      <span className="max-w-sm text-[13px] text-muted-foreground">{body}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// タブ: ビルドログ / プレビューなし
// ---------------------------------------------------------------------------

const clock = (at: number) => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`
}

const STATUS_TONE: Record<LiveEvent["status"], string> = {
  start: "text-zinc-400",
  info: "text-zinc-400",
  ok: "text-zinc-100",
  warn: "text-amber-300",
  error: "text-red-400",
}

/** レジストリの公開ログ。新しい順に並べ、届いたものを上に足していく */
function BuildLog({ registryId }: { registryId: string }) {
  const { events, loaded } = useLiveEvents({ registryId })
  const rows = React.useMemo(() => [...events].reverse().slice(0, 400), [events])
  if (loaded && rows.length === 0)
    return <EmptyStage title="No builds logged yet" body="Every docs, demo, build and capture step for this registry shows up here as it happens." />
  return (
    <div className="code-surface overflow-hidden rounded-[14px] border border-zinc-800">
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2.5">
        <span className="label-mono text-zinc-400">Build log</span>
        <span className="inline-flex items-center gap-2 font-mono text-[11px] text-zinc-400">
          <SignalDot pulse />
          following
        </span>
      </div>
      <ol className="max-h-[720px] overflow-y-auto py-2 font-mono text-[12px] leading-relaxed">
        {!loaded &&
          Array.from({ length: 6 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 読み込み中の飾り
            <li key={i} className="px-4 py-1">
              <span className="skeleton block h-3.5 rounded opacity-20" style={{ width: `${60 + ((i * 37) % 35)}%` }} />
            </li>
          ))}
        {rows.map((e) => {
          const name = e.componentId ? splitComponentId(e.componentId).name : null
          return (
            <li key={e.id} className="grid animate-rise grid-cols-[76px_64px_minmax(0,1fr)] gap-x-3 px-4 py-0.5 hover:bg-white/[0.03] sm:grid-cols-[84px_72px_minmax(0,1fr)]">
              <span className="text-zinc-600">{clock(e.at)}</span>
              <span className={STATUS_TONE[e.status]}>{e.stage}</span>
              <span className="min-w-0 break-words text-zinc-300">
                {name && (
                  <Link to="/c/$registryId/$name" params={{ registryId, name }} className="mr-2 text-sky-300 hover:underline">
                    {name}
                  </Link>
                )}
                <span className={e.status === "error" ? "text-red-300" : e.status === "warn" ? "text-amber-200" : undefined}>{e.message}</span>
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const MISSING_LABEL: Record<string, string> = {
  Failed: "build failed",
  Skipped: "skipped",
  NotCaptured: "not built",
  Built: "not captured",
}

/** プレビューが無いアイテム。理由はログに残っていれば (直近のエラー) 出す */
function NoPreview({ registryId, cards }: { registryId: string; cards: ReadonlyArray<ComponentCardDto> }) {
  const { events } = useLiveEvents({ registryId })
  const reasons = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const e of events) if (e.componentId && (e.status === "error" || e.status === "warn")) map.set(e.componentId, e.message)
    return map
  }, [events])
  if (cards.length === 0)
    return <EmptyStage title="Every visual item has a live demo" body="Items that can't be built as published would be listed here, with the reason." />
  return (
    <ul className="overflow-hidden rounded-[14px] border bg-card">
      {cards.map((c) => {
        const reason = reasons.get(c.id)
        return (
          <li key={c.id} className="grid gap-x-4 gap-y-1 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-center">
            <Link to="/c/$registryId/$name" params={{ registryId, name: c.name }} className="flex min-w-0 items-baseline gap-2 hover:underline">
              <span className="truncate font-mono text-[13px]">{c.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-faint">{c.kind}</span>
            </Link>
            <span className="min-w-0 text-[13px] text-muted-foreground">
              <span className="mr-2 font-mono text-[11px] text-faint uppercase">
                {c.status.doc === "Failed" ? "docs failed" : (MISSING_LABEL[c.status.preview] ?? c.status.preview)}
              </span>
              {reason && <span className="break-words">{reason}</span>}
            </span>
            <a
              href={previewReportUrl({ registryId, name: c.name })}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-[12.5px] text-muted-foreground hover:text-foreground"
            >
              Report <ArrowUpRight className="size-3" />
            </a>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// 右のレール
// ---------------------------------------------------------------------------

function RailCard({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-[14px] border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono">{label}</span>
        {aside}
      </div>
      {children}
    </section>
  )
}

const Chip = ({ children, live = false }: { children: React.ReactNode; live?: boolean | undefined }) => (
  <span className="inline-flex h-5 items-center gap-1.5 rounded-[5px] bg-muted px-1.5 font-mono text-[10.5px] tracking-wide text-muted-foreground">
    {live && <SignalDot pulse className="size-[5px]" />}
    {children}
  </span>
)

/** テーマの判定状態を閲覧者向けの 1 行にする (運営情報の根拠・提案の中身は出さない) */
const themeView = (registry: RegistryDto): { chip: string; live?: boolean; text: React.ReactNode; detected: string } => {
  const theme = registry.theme
  const variants = registry.previewConfig.variants?.length ?? 0
  const more = variants > 1 ? ` ${variants} themes, switchable on each component page.` : ""
  switch (theme._tag) {
    case "Resolved":
      switch (theme.source) {
        case "registry-item":
          return {
            chip: "AUTO",
            detected: "registry-item",
            text: (
              <>
                Detected from the <span className="font-mono text-foreground/80">registry:style</span> item in registry.json and applied to every preview.{more}
              </>
            ),
          }
        case "agent":
          return { chip: "AUTO", detected: "agent", text: `Read from the registry's install steps and applied to every preview.${more}` }
        case "manual":
          return { chip: "MANUAL", detected: "manual", text: `Set by the operator from the registry's docs and applied to every preview.${more}` }
        default:
          return { chip: "NEUTRAL", detected: "none", text: "This registry ships no theme of its own, so previews use shadcn's neutral theme." }
      }
    case "Proposed":
      return { chip: "NEUTRAL", detected: "proposed", text: "A theme was found but not confidently; previews use shadcn's neutral theme until it's reviewed." }
    case "AgentPending":
      return { chip: "DETECTING", live: true, detected: "pending", text: "Reading the install steps to find this registry's theme. Previews wait until it's decided." }
    case "Failed":
      return { chip: "NEUTRAL", detected: "failed", text: "The theme couldn't be detected, so previews use shadcn's neutral theme." }
    case "Unresolved":
      return { chip: "PENDING", detected: "unresolved", text: "The theme is detected on the next sync. Until then previews use shadcn's neutral theme." }
  }
}

function ThemeCard({ registry }: { registry: RegistryDto }) {
  const view = themeView(registry)
  const tokens: ThemeTokensDto = registry.previewConfig.tokens ?? NEUTRAL_TOKENS
  return (
    <RailCard label="Theme" aside={<Chip live={view.live}>{view.chip}</Chip>}>
      <div className="flex flex-col gap-1.5">
        <SwatchRow map={tokens.light} />
        {tokens.dark && Object.keys(tokens.dark).length > 0 && <SwatchRow map={tokens.dark} />}
      </div>
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{view.text}</p>
      <a
        href={themeReportUrl({ registry: registry.namespace ?? registry.id, detected: view.detected })}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-0.5 text-[12.5px] text-foreground/80 hover:text-foreground"
      >
        Theme looks wrong? Report on GitHub <ArrowUpRight className="size-3" />
      </a>
    </RailCard>
  )
}

/** 色見本 1 行。値は検証済みのトークンだが、style には色として解釈できるものだけ効く */
function SwatchRow({ map }: { map: Readonly<Record<string, string>> }) {
  const names = SWATCH_TOKENS.filter((n) => map[n])
  if (names.length === 0) return null
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {names.map((n) => (
        <span key={n} title={`${n}: ${map[n]}`} className="aspect-square rounded-md border" style={{ background: map[n] }} />
      ))}
    </div>
  )
}

const inDays = (ms: number) => {
  const days = Math.round(ms / 86_400_000)
  if (ms <= 0) return "due"
  if (days < 1) return `in ${Math.max(1, Math.round(ms / 3_600_000))}h`
  return `in ${days} day${days === 1 ? "" : "s"}`
}

function SyncCard({ registry }: { registry: RegistryDto }) {
  const status = registry.status
  const last = status._tag === "Disabled" || status._tag === "Pending" ? null : status.lastSyncedAt
  const now = Date.now()
  const elapsed = last === null ? 0 : Math.min(1, Math.max(0, (now - last) / SYNC_INTERVAL_MS))
  return (
    <RailCard
      label="Sync"
      aside={
        status._tag === "Syncing" ? (
          <Chip live>SYNCING</Chip>
        ) : status._tag === "Failed" ? (
          <span className="font-mono text-[10.5px] text-destructive">FAILED</span>
        ) : status._tag === "Disabled" ? (
          <Chip>DISABLED</Chip>
        ) : null
      }
    >
      <dl className="flex flex-col gap-2 text-[13px]">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Last synced</dt>
          <dd className="font-mono" suppressHydrationWarning>
            {last === null ? "never" : timeAgo(last, now)}
          </dd>
        </div>
        {status._tag !== "Disabled" && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Next sync</dt>
            <dd className="font-mono" suppressHydrationWarning>
              {status._tag === "Syncing" ? "now" : last === null ? "queued" : inDays(last + SYNC_INTERVAL_MS - now)}
            </dd>
          </div>
        )}
        {status._tag === "Active" && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Items in registry.json</dt>
            <dd className="font-mono">{status.itemCount}</dd>
          </div>
        )}
      </dl>
      {status._tag === "Failed" && <p className="text-[12.5px] leading-relaxed text-destructive">{status.reason}</p>}
      {status._tag === "Disabled" && <p className="text-[12.5px] leading-relaxed text-muted-foreground">{status.reason}</p>}
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", status._tag === "Syncing" ? "w-full animate-signal bg-signal" : "bg-foreground/70")}
          style={status._tag === "Syncing" ? undefined : { width: `${Math.round(elapsed * 100)}%` }}
          suppressHydrationWarning
        />
      </div>
      <span className="font-mono text-[11px] text-faint">every 7 days · only changed items rebuild</span>
    </RailCard>
  )
}

function RecentBuilds({ registryId }: { registryId: string }) {
  const summary = useLiveSummary(registryId)
  const rows = React.useMemo(() => {
    if (!summary) return []
    const active = summary.active.map((a) => ({ key: `a:${a.componentId}`, componentId: a.componentId, at: a.latest.at, building: true }))
    const seen = new Set(active.map((a) => a.componentId))
    const done = summary.captured
      .filter((e) => e.componentId && !seen.has(e.componentId))
      .map((e) => ({ key: `c:${e.id}`, componentId: e.componentId!, at: e.at, building: false }))
    return [...active, ...done].slice(0, 6)
  }, [summary])
  return (
    <RailCard
      label="Recent builds"
      aside={
        <Link from="/registries/$registryId" search={{ tab: "log" }} resetScroll={false} className="text-xs text-muted-foreground hover:text-foreground">
          log →
        </Link>
      }
    >
      {summary === null ? (
        <div className="flex flex-col gap-2.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="skeleton h-3.5 rounded" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">Nothing built in the last 24 hours.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((r) => {
            const name = splitComponentId(r.componentId).name
            return (
              <li key={r.key} className="animate-rise">
                <Link to="/c/$registryId/$name" params={{ registryId, name }} className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 text-[12.5px]">
                  {r.building ? <SignalDot pulse /> : <span className="size-[7px] rounded-full bg-foreground/80" />}
                  <span className="truncate font-mono text-foreground/85">{name}</span>
                  <span className={cn("font-mono text-[11px]", r.building ? "text-signal-foreground" : "text-faint")}>
                    {r.building ? "building" : timeAgo(r.at)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </RailCard>
  )
}

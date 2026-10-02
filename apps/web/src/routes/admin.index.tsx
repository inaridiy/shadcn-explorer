import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { ArrowUpRight, Check, ChevronDown, Loader2, Plus, RefreshCw, RotateCcw } from "lucide-react"
import * as React from "react"
import { ListingBadge, SignalDot } from "~/components/listing-badge"
import { Badge } from "~/components/ui/badge"
import { Button, buttonVariants } from "~/components/ui/button"
import { cn } from "~/lib/utils"
import {
  directoryStatusFn,
  lifecycleOverviewFn,
  regenerateFn,
  registryRequestsFn,
  retryDirectoryEntryFn,
  runDirectoryIntakeFn,
} from "~/server/admin"
import type { RegistryDto } from "~/server/dto"
import { approveThemeFn, listRegistriesFn, redetectThemeFn, rejectThemeFn, resyncRegistryFn } from "~/server/registries"
import { usageSummaryFn } from "~/server/usage"

export const Route = createFileRoute("/admin/")({
  loader: async () => {
    const [usage, registries, directory, requests, overview] = await Promise.all([
      usageSummaryFn(),
      listRegistriesFn(),
      directoryStatusFn(),
      // GitHub に届かなくても画面は出す
      registryRequestsFn().catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        requests: [] as const,
      })),
      lifecycleOverviewFn(),
    ])
    // 相対時刻は SSR とハイドレーションで同じ値を使う (ずれると表示が食い違う)
    return { usage, registries, directory, requests, overview, now: Date.now() }
  },
  component: AdminPage,
})

interface LoaderData {
  readonly usage: Awaited<ReturnType<typeof usageSummaryFn>>
  readonly directory: Awaited<ReturnType<typeof directoryStatusFn>>
  readonly requests: Awaited<ReturnType<typeof registryRequestsFn>> | { readonly ok: false; readonly error: string; readonly requests: readonly [] }
}
type Overview = Extract<Awaited<ReturnType<typeof lifecycleOverviewFn>>, { ok: true }>["value"]
type DirectoryStatus = Extract<LoaderData["directory"], { ok: true }>["value"]

const REPO = "https://github.com/inaridiy/shadcn-explorer"
const issuesWithLabel = (label: string) => `${REPO}/issues?q=${encodeURIComponent(`is:issue is:open label:${label}`)}`
/** wrangler.jsonc の日次 cron ("17 3 * * *") */
const NIGHTLY_UTC = { hour: 3, minute: 17 }
const DAY = 86_400_000

/**
 * 運営者の画面 (v0.7): ライフサイクルの見張り。
 * 上段: 当月のコストと今日の無料枠。カード: 公式ディレクトリの自動取り込み / コミュニティの申請 / 再同期 / ユーザーからの報告。
 * 下段: レジストリの一覧と、再同期・作り直し・テーマの操作。数字はすべて実データ (無いものは出さない)
 */
function AdminPage() {
  const { usage, registries, directory, requests, overview, now } = Route.useLoaderData()
  const ov = overview.ok ? overview.value : null
  const [showDirectory, setShowDirectory] = React.useState(false)

  return (
    <div className="flex flex-col gap-7 pt-9">
      <header className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
        <div className="flex flex-col gap-1.5">
          <span className="label-mono">Admin</span>
          <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.04em]">Lifecycle</h1>
          <Link to="/admin/registries/new" className={cn(buttonVariants({ size: "sm" }), "mt-2 w-fit")}>
            <Plus /> Register a registry
          </Link>
        </div>
        <SpendMeter usage={usage} overview={ov} />
      </header>

      {!overview.ok && <ErrorLine message={`Overview unavailable: ${overview.error.message}`} />}

      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <DirectoryCard directory={directory} overview={ov} expanded={showDirectory} onToggle={() => setShowDirectory((v) => !v)} />
        <RequestsCard requests={requests} />
        <ResyncCard registries={registries} overview={ov} now={now} />
        <ReportsCard />
      </div>

      {showDirectory && directory.ok && <DirectoryPanel status={directory.value} />}

      <RequestsPanel requests={requests} />

      <RegistriesTable registries={registries} overview={ov} now={now} />

      <div className="grid gap-3.5 md:grid-cols-3">
        <Note label="Regenerate ▾">
          Docs only · Previews only (reuses demos, no LLM) · Everything. Per registry here; resets the stages and queues the
          components again.
        </Note>
        <Note label="Theme ▾">
          Approve a proposal · Use neutral (reject it) · Re-detect. Auto-applied themes need no approval; manual themes are never
          overwritten. Edit manually on the registry page.
        </Note>
        <Note label="Costs">
          {usage.categories.length === 0
            ? "Nothing recorded this month."
            : `${usage.categories.map((c) => `${c.category} $${c.usd.toFixed(3)} (${c.count})`).join(" · ")}.`}{" "}
          Costs show only here, never on public pages.
        </Note>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 上段: コストと無料枠
// ---------------------------------------------------------------------------

function SpendMeter({ usage, overview }: { usage: LoaderData["usage"]; overview: Overview | null }) {
  const ratio = usage.budgetUsd > 0 ? Math.min(1, usage.totalUsd / usage.budgetUsd) : 0
  const soft = overview?.lifecycle.softLimitRatio ?? 0.8
  return (
    <div className="flex w-full flex-col gap-2 lg:w-[400px]">
      <div className="flex justify-between text-[13px]">
        <span className="text-muted-foreground">Spend this month</span>
        <span className="font-mono">
          ${usage.totalUsd.toFixed(2)} of ${usage.budgetUsd}
        </span>
      </div>
      <Meter ratio={ratio} marker={soft} />
      <span className="font-mono text-[11px] text-faint">
        previews pause at {Math.round(soft * 100)}%, everything at 100%
      </span>
      {overview && overview.freeQuota.groups.length > 0 && (
        <div className="mt-2 flex flex-col gap-2 border-t pt-3">
          <div className="flex justify-between text-[13px]">
            <span className="text-muted-foreground">OpenAI free tokens today (UTC)</span>
            <span className="font-mono text-[11px] text-faint">
              stops at {Math.round(overview.freeQuota.useRatio * 100)}% · then {overview.freeQuota.overflow === "Paid" ? "paid" : "pause"}
            </span>
          </div>
          {overview.freeQuota.groups.map((g) => {
            const r = g.dailyTokens > 0 ? Math.min(1, g.usedTokens / g.dailyTokens) : 0
            return (
              <div key={g.name} className="flex flex-col gap-1" title={g.models.join(", ")}>
                <div className="flex justify-between font-mono text-[11.5px]">
                  <span className="text-muted-foreground">{groupLabel(g)}</span>
                  <span>
                    {formatTokens(g.usedTokens)} / {formatTokens(g.dailyTokens)}
                  </span>
                </div>
                <Meter ratio={r} marker={overview.freeQuota.useRatio} thin />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 群の表示名: 実際に使うモデル (luna) を前に出す */
const groupLabel = (g: { name: string; models: ReadonlyArray<string> }) => {
  const luna = g.models.find((m) => m.endsWith("-luna"))
  return luna ? `${luna} group` : `${g.name} group`
}

const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${+(n / 1_000).toFixed(1)}k` : String(n)

function Meter({ ratio, marker, thin = false }: { ratio: number; marker?: number; thin?: boolean }) {
  return (
    <div className={cn("relative overflow-hidden rounded-full bg-muted", thin ? "h-1.5" : "h-2")}>
      <div className="h-full rounded-full bg-foreground" style={{ width: `${ratio * 100}%` }} />
      {marker !== undefined && <div className="absolute inset-y-0 w-px bg-faint/60" style={{ left: `${marker * 100}%` }} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// カード
// ---------------------------------------------------------------------------

function StatCard({
  label,
  aside,
  value,
  children,
  actions,
}: {
  label: string
  aside?: React.ReactNode
  value: React.ReactNode
  children?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-[14px] border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="label-mono">{label}</span>
        {aside}
      </div>
      <span className="font-mono text-[26px] leading-none font-medium tracking-[-0.03em]">{value}</span>
      <div className="flex-1 text-[12.5px] leading-relaxed text-muted-foreground">{children}</div>
      {actions && <div className="flex flex-wrap gap-1.5">{actions}</div>}
    </section>
  )
}

function DirectoryCard({
  directory,
  overview,
  expanded,
  onToggle,
}: {
  directory: LoaderData["directory"]
  overview: Overview | null
  expanded: boolean
  onToggle: () => void
}) {
  const action = useAction()
  if (!directory.ok) {
    return (
      <StatCard label="Official directory" value="—">
        <span className="text-destructive">{directory.error.message}</span>
      </StatCard>
    )
  }
  const { counts } = directory.value
  const eligible = counts.New + counts.Imported
  const listed = eligible + counts.Skipped
  const auto = overview?.lifecycle.directoryIntake
  return (
    <StatCard
      label="Official directory"
      aside={
        auto === undefined ? null : auto ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-signal-foreground">
            <SignalDot pulse className="size-1.5" />
            AUTO
          </span>
        ) : (
          <span className="font-mono text-[10.5px] text-faint" title="DIRECTORY_INTAKE is off">
            AUTO OFF
          </span>
        )
      }
      value={
        <>
          {counts.Imported} <span className="text-muted-foreground">/ {eligible}</span>
        </>
      }
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={action.pending !== null}
            onClick={() =>
              action.run("intake", async () => {
                const r = await runDirectoryIntakeFn()
                if (!r.ok) throw new Error(r.error.message)
                const { sync, intake } = r.value
                if (intake.deferred) return `Listed ${sync.listed}. Deferred: the enrichment backlog is full.`
                return `Listed ${sync.listed} (+${sync.added}). Imported ${intake.imported.length}, skipped ${intake.skipped.length}, failed ${intake.failed.length}.`
              })
            }
          >
            {action.pending === "intake" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Import a batch now
          </Button>
          <Button variant="outline" size="sm" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? "Hide list" : `Skipped (${counts.Skipped})`}
          </Button>
        </>
      }
    >
      {listed} listed · {counts.Skipped} skipped
      {counts.Delisted > 0 && ` · ${counts.Delisted} delisted`}.
      {overview &&
        ` New registries join at ${overview.lifecycle.intakePerRun} a day while fewer than ${overview.lifecycle.maxBacklog.toLocaleString("en-US")} components are unfinished.`}
      <ActionMessage action={action} />
    </StatCard>
  )
}

function RequestsCard({ requests }: { requests: LoaderData["requests"] }) {
  const email = requests.ok ? requests.email : null
  return (
    <StatCard
      label="Community requests"
      value={requests.ok ? `${requests.requests.length} open` : "—"}
      actions={
        <>
          <a href="#requests" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Review
          </a>
          <span
            aria-disabled="true"
            title="Paid checkout (Stripe) is not implemented yet"
            className="inline-flex h-8 items-center rounded-lg border border-dashed px-2 font-mono text-[11px] text-faint"
          >
            STRIPE · COMING LATER
          </span>
        </>
      }
    >
      From GitHub issues labeled <span className="font-mono">registry-request</span>
      {email ? (
        <>
          {" "}
          and email (<span className="font-mono">{email}</span>)
        </>
      ) : null}
      . Imported ones are listed with a Community badge.
      {!requests.ok && <span className="block text-destructive">{requests.error}</span>}
    </StatCard>
  )
}

/** 前回の同期から間隔が過ぎる時刻 (scheduleResyncAll と同じ規則。未同期は今すぐ) */
const resyncDueAt = (r: RegistryDto, intervalMs: number): number | null => {
  const s = r.status
  if (s._tag === "Pending") return 0
  if (s._tag === "Active") return s.lastSyncedAt + intervalMs
  if (s._tag === "Failed") return s.lastSyncedAt === null ? 0 : s.lastSyncedAt + intervalMs
  return null
}

/** dueAt 以降で最初の日次 cron の時刻 */
const nextNightlyRun = (dueAt: number, now: number) => {
  const from = Math.max(dueAt, now)
  const d = new Date(from)
  let run = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), NIGHTLY_UTC.hour, NIGHTLY_UTC.minute)
  if (run < from) run += DAY
  return run
}

function ResyncCard({ registries, overview, now }: { registries: ReadonlyArray<RegistryDto>; overview: Overview | null; now: number }) {
  const router = useRouter()
  const action = useAction()
  const interval = overview?.lifecycle.resyncIntervalMs ?? null
  const due =
    interval === null
      ? []
      : registries
          .map((r) => ({ r, at: resyncDueAt(r, interval) }))
          .filter((x): x is { r: RegistryDto; at: number } => x.at !== null && x.at <= now + DAY)
          .sort((a, b) => a.at - b.at)
  const tonight = nextNightlyRun(now, now)
  return (
    <StatCard
      label="Re-sync"
      value={interval === null ? "—" : `${due.length} due`}
      actions={
        due.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            disabled={action.pending !== null}
            onClick={() =>
              action.run("resync", async () => {
                for (const { r } of due) await resyncRegistryFn({ data: { registryId: r.id } })
                await router.invalidate()
                return `Scheduled ${due.length} re-sync${due.length === 1 ? "" : "s"}.`
              })
            }
          >
            {action.pending === "resync" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Re-sync due now
          </Button>
        )
      }
    >
      {interval !== null && `Each registry every ${Math.round(interval / DAY)} days, spread across nights. `}
      Next run {relative(tonight, now)} ({pad(NIGHTLY_UTC.hour)}:{pad(NIGHTLY_UTC.minute)} UTC).
      {due.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-[11.5px]">
          {due.slice(0, 4).map(({ r, at }) => (
            <li key={r.id} className="flex justify-between gap-2">
              <span className="truncate text-foreground/80">{r.namespace ?? r.name}</span>
              <span className="shrink-0 text-faint">{at <= now ? "overdue" : relative(at, now)}</span>
            </li>
          ))}
          {due.length > 4 && <li className="text-faint">+{due.length - 4} more</li>}
        </ul>
      )}
      <ActionMessage action={action} />
    </StatCard>
  )
}

function ReportsCard() {
  return (
    <StatCard
      label="User reports"
      value={<span className="text-[20px]">GitHub</span>}
      actions={
        <a href={`${REPO}/issues`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Open on GitHub <ArrowUpRight />
        </a>
      }
    >
      <span className="mb-1.5 block">Issue forms from component and registry pages.</span>
      <span className="flex flex-col gap-1">
        {["preview-broken", "theme-wrong"].map((label) => (
          <a
            key={label}
            href={issuesWithLabel(label)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between font-mono text-foreground/80 hover:text-foreground"
          >
            {label}
            <ArrowUpRight className="size-3.5 text-faint" />
          </a>
        ))}
      </span>
    </StatCard>
  )
}

// ---------------------------------------------------------------------------
// 公式ディレクトリの詳細 (見送ったもの・次に取り込むもの)
// ---------------------------------------------------------------------------

function DirectoryPanel({ status }: { status: DirectoryStatus }) {
  return (
    <div className="grid gap-3.5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Panel label={`Skipped (${status.skipped.length})`} hint="Retry puts it back in the queue for the next batch">
        {status.skipped.length === 0 ? (
          <Empty>Nothing skipped.</Empty>
        ) : (
          status.skipped.map((e) => <SkippedRow key={e.name} entry={e} />)
        )}
      </Panel>
      <Panel label="Up next" hint="Ranking order">
        {status.next.length === 0 ? (
          <Empty>The queue is empty.</Empty>
        ) : (
          status.next.map((e) => (
            <div key={e.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-border/60 px-[18px] py-2.5 text-[13px] first:border-t-0">
              <span className="truncate font-mono">{e.name}</span>
              <span className="font-mono text-[12px] text-muted-foreground">
                {e.itemCount !== null ? `${e.itemCount} items` : "—"}
                {e.healthStatus && e.healthStatus !== "healthy" ? ` · ${e.healthStatus}` : ""}
              </span>
            </div>
          ))
        )}
      </Panel>
    </div>
  )
}

function SkippedRow({ entry }: { entry: DirectoryStatus["skipped"][number] }) {
  const router = useRouter()
  const action = useAction()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-3 border-t border-border/60 px-[18px] py-2.5 text-[13px] first:border-t-0">
      <span className="truncate font-mono" title={entry.url}>
        {entry.name}
      </span>
      <span className="truncate text-[12.5px] text-muted-foreground" title={entry.skipReason ?? undefined}>
        {entry.skipReason ?? "—"}
        {entry.attempts > 0 && <span className="font-mono text-faint"> · {entry.attempts} attempts</span>}
      </span>
      <div className="flex items-center justify-end gap-2">
        <ActionMessage action={action} inline />
        <Button
          variant="outline"
          size="sm"
          disabled={action.pending !== null}
          onClick={() =>
            action.run("retry", async () => {
              const r = await retryDirectoryEntryFn({ data: { name: entry.name } })
              if (!r.ok) throw new Error(r.error.message)
              await router.invalidate()
              return r.value ? "Queued" : "Not skipped anymore"
            })
          }
        >
          {action.pending === "retry" ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 申請 (GitHub Issues)
// ---------------------------------------------------------------------------

function RequestsPanel({ requests }: { requests: LoaderData["requests"] }) {
  const email = requests.ok ? requests.email : null
  return (
    <Panel id="requests" label="Requests" hint="Importing makes it searchable with a Community badge">
      {!requests.ok ? (
        <Empty>Could not load GitHub issues: {requests.error}</Empty>
      ) : requests.requests.length === 0 ? (
        <Empty>No open requests.</Empty>
      ) : (
        requests.requests.map((r) => (
          <div
            key={r.number}
            className="grid grid-cols-[90px_minmax(0,1fr)_auto] items-center gap-4 border-t border-border/60 px-[18px] py-3 text-[13px] first:border-t-0 md:grid-cols-[110px_minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <a href={r.url} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-muted-foreground hover:text-foreground">
              GitHub #{r.number}
            </a>
            <span className="truncate font-mono" title={r.title}>
              {r.registry ?? <span className="text-faint">{r.title}</span>}
            </span>
            <span className="hidden truncate font-mono text-[12px] text-muted-foreground md:block">
              {r.author ? `@${r.author}` : ""} · {r.createdAt.slice(0, 10)}
            </span>
            <div className="flex justify-end gap-1.5">
              <Link
                to="/admin/registries/new"
                search={{ input: r.registry ?? undefined, reference: r.url, via: "github" }}
                className={buttonVariants({ size: "sm" })}
              >
                Import
              </Link>
              <a href={r.url} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Issue <ArrowUpRight />
              </a>
            </div>
          </div>
        ))
      )}
      {email && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-[18px] py-3 text-[12.5px] text-muted-foreground">
          <span>
            Email requests arrive at <span className="font-mono text-foreground/80">{email}</span>.
          </span>
          <Link to="/admin/registries/new" search={{ via: "email" }} className={buttonVariants({ variant: "outline", size: "sm" })}>
            Import an emailed request
          </Link>
        </div>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// レジストリの一覧
// ---------------------------------------------------------------------------

const TABLE_COLS = "grid-cols-[minmax(180px,1.2fr)_100px_64px_64px_minmax(170px,1.3fr)_130px_minmax(290px,auto)]"

function RegistriesTable({ registries, overview, now }: { registries: ReadonlyArray<RegistryDto>; overview: Overview | null; now: number }) {
  return (
    <section className="overflow-x-auto rounded-[14px] border bg-card">
      <div className="min-w-[1080px]">
        <div className={cn("label-mono grid gap-3.5 border-b bg-muted px-[18px] py-3", TABLE_COLS)}>
          <span>Registry ({registries.length})</span>
          <span>Source</span>
          <span>Items</span>
          <span>Live</span>
          <span>Theme</span>
          <span>Sync</span>
          <span className="text-right">Actions</span>
        </div>
        {registries.length === 0 ? (
          <Empty>No registries yet.</Empty>
        ) : (
          registries.map((r) => <RegistryRow key={r.id} registry={r} overview={overview} now={now} />)
        )}
      </div>
    </section>
  )
}

function RegistryRow({ registry, overview, now }: { registry: RegistryDto; overview: Overview | null; now: number }) {
  const router = useRouter()
  const action = useAction()
  const { status, theme } = registry
  const live = overview?.liveByRegistry[registry.id]
  const lastSynced =
    status._tag === "Active" || status._tag === "Failed" || status._tag === "Syncing" ? status.lastSyncedAt : null
  const dueAt = overview ? resyncDueAt(registry, overview.lifecycle.resyncIntervalMs) : null

  const run = (key: string, fn: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>, done: string) =>
    action.run(key, async () => {
      const r = await fn()
      if (!r.ok) throw new Error(r.error.message)
      await router.invalidate()
      return done
    })

  const regenerate = (scope: "docs" | "previews" | "all") => {
    const what = scope === "docs" ? "docs" : scope === "previews" ? "previews (demos are reused)" : "docs and previews"
    if (!window.confirm(`Regenerate ${what} for all ${registry.componentCount} components of ${registry.namespace ?? registry.name}?`)) return
    void action.run(`regen-${scope}`, async () => {
      const r = await regenerateFn({ data: { registryId: registry.id, scope } })
      if (!r.ok) throw new Error(r.error.message)
      await router.invalidate()
      return `Queued ${r.value.scheduled}`
    })
  }

  return (
    <div className={cn("grid items-center gap-3.5 border-b border-border/60 px-[18px] py-3 text-[13px] last:border-b-0", TABLE_COLS)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="inline-flex min-w-0 items-center gap-2 font-mono">
          <StatusDot status={status} />
          <Link to="/registries/$registryId" params={{ registryId: registry.id }} className="truncate hover:underline">
            {registry.namespace ?? registry.name}
          </Link>
        </span>
        {status._tag === "Failed" ? (
          <span className="truncate pl-[15px] text-[11px] text-destructive" title={status.reason}>
            {status.reason}
          </span>
        ) : (
          <span className="truncate pl-[15px] font-mono text-[11px] text-faint" title={registry.indexUrl}>
            {registry.indexUrl.replace(/^https?:\/\//, "")}
          </span>
        )}
      </div>
      <span>
        <ListingBadge listing={listingOf(registry)} />
      </span>
      <span className="font-mono text-muted-foreground">{registry.componentCount}</span>
      <span className="font-mono text-foreground/80">{live ?? (overview ? 0 : "—")}</span>
      <ThemeCell theme={theme} />
      <div className="flex flex-col gap-0.5 font-mono">
        <span className="text-[12px] text-foreground/80">
          {status._tag === "Syncing" ? (
            <span className="text-signal-foreground">syncing</span>
          ) : status._tag === "Pending" ? (
            "queued"
          ) : status._tag === "Disabled" ? (
            "disabled"
          ) : lastSynced !== null ? (
            <span title={new Date(lastSynced).toISOString()}>{relative(lastSynced, now)}</span>
          ) : (
            "—"
          )}
        </span>
        <span className="text-[11px] text-faint">
          {dueAt === null || status._tag === "Syncing" || status._tag === "Pending"
            ? "—"
            : `next ${relative(nextNightlyRun(dueAt, now), now)}`}
        </span>
      </div>
      <div className="flex flex-col items-end gap-1">
        <div className="flex justify-end gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={action.pending !== null || status._tag === "Syncing"}
            onClick={() => run("resync", () => resyncRegistryFn({ data: { registryId: registry.id } }), "Re-sync scheduled")}
          >
            {action.pending === "resync" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Re-sync
          </Button>
          <Menu label="Regenerate" busy={action.pending?.startsWith("regen-") ?? false} disabled={action.pending !== null}>
            <MenuItem onSelect={() => regenerate("docs")} hint="LLM docs">
              Docs only
            </MenuItem>
            <MenuItem onSelect={() => regenerate("previews")} hint="reuses demos">
              Previews only
            </MenuItem>
            <MenuItem onSelect={() => regenerate("all")} hint="docs + previews">
              Everything
            </MenuItem>
          </Menu>
          <Menu label="Theme" busy={action.pending?.startsWith("theme-") ?? false} disabled={action.pending !== null}>
            <MenuItem
              disabled={theme._tag !== "Proposed"}
              onSelect={() => run("theme-approve", () => approveThemeFn({ data: { registryId: registry.id } }), "Applied; rebuilding previews")}
              hint={theme._tag === "Proposed" ? `${theme.proposal.confidence} confidence` : "no proposal"}
            >
              <Check /> Approve proposal
            </MenuItem>
            <MenuItem
              disabled={theme._tag !== "Proposed"}
              onSelect={() => run("theme-reject", () => rejectThemeFn({ data: { registryId: registry.id } }), "Using neutral")}
              hint="reject proposal"
            >
              Use neutral
            </MenuItem>
            <MenuItem
              onSelect={() => run("theme-redetect", () => redetectThemeFn({ data: { registryId: registry.id } }), "Re-detect scheduled")}
              hint="registry.json → agent"
            >
              <RefreshCw /> Re-detect
            </MenuItem>
            <MenuLink to={registry.id}>Edit manually</MenuLink>
          </Menu>
        </div>
        <ActionMessage action={action} inline />
      </div>
    </div>
  )
}

const listingOf = (r: RegistryDto) =>
  r.listing._tag === "Official" && !r.listing.listed ? ("Community" as const) : r.listing._tag

function StatusDot({ status }: { status: RegistryDto["status"] }) {
  if (status._tag === "Syncing") return <SignalDot pulse />
  const cls =
    status._tag === "Active"
      ? "bg-foreground"
      : status._tag === "Failed" || status._tag === "Disabled"
        ? "bg-destructive"
        : "border border-faint"
  return <span title={status._tag} className={cn("inline-block size-[7px] shrink-0 rounded-full", cls)} />
}

const SOURCE_LABEL: Record<string, string> = {
  "registry-item": "Auto · registry.json",
  agent: "Auto · agent",
  manual: "Manual",
  none: "Neutral",
}

function ThemeCell({ theme }: { theme: RegistryDto["theme"] }) {
  let main: React.ReactNode
  let sub: string
  switch (theme._tag) {
    case "Resolved":
      main = SOURCE_LABEL[theme.source] ?? theme.source
      sub = theme.source === "manual" ? "kept on re-detect" : theme.note
      break
    case "AgentPending":
      main = (
        <span className="inline-flex items-center gap-1.5 text-signal-foreground">
          <SignalDot pulse className="size-1.5" />
          Detecting…
        </span>
      )
      sub = "agent reading install docs"
      break
    case "Proposed":
      main = <Badge variant="warning">Proposed</Badge>
      sub = `${theme.proposal.source === "agent" ? "agent" : "registry.json"} · ${theme.proposal.confidence} · previews use neutral`
      break
    case "Failed":
      main = <span className="text-destructive">Failed</span>
      sub = theme.reason
      break
    case "Unresolved":
      main = "Unresolved"
      sub = "detects on next sync"
      break
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-foreground/80">{main}</span>
      <span className="truncate font-mono text-[11px] text-faint" title={sub}>
        {sub}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 小物
// ---------------------------------------------------------------------------

/** 運営者の操作 1 つ分の状態 (実行中・結果のメッセージ) */
function useAction() {
  const [pending, setPending] = React.useState<string | null>(null)
  const [message, setMessage] = React.useState<{ text: string; error: boolean } | null>(null)
  const run = React.useCallback(async (key: string, fn: () => Promise<string>) => {
    setPending(key)
    setMessage(null)
    try {
      setMessage({ text: await fn(), error: false })
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setPending(null)
    }
  }, [])
  return { pending, message, run }
}

function ActionMessage({ action, inline = false }: { action: ReturnType<typeof useAction>; inline?: boolean }) {
  if (!action.message) return null
  return (
    <span
      role="status"
      className={cn(
        "font-mono text-[11px]",
        inline ? "max-w-[280px] truncate" : "mt-1.5 block",
        action.message.error ? "text-destructive" : "text-muted-foreground",
      )}
      title={action.message.text}
    >
      {action.message.text}
    </span>
  )
}

const MenuContext = React.createContext<() => void>(() => {})

/**
 * 小さなドロップダウン (外側のクリック・Esc・スクロールで閉じる)。
 * 一覧は横スクロールの枠 (overflow) の中にあるので、枠に切られないよう fixed で出す
 */
function Menu({ label, busy, disabled, children }: { label: string; busy: boolean; disabled: boolean; children: React.ReactNode }) {
  const [anchor, setAnchor] = React.useState<{ top: number; right: number } | null>(null)
  const ref = React.useRef<HTMLDivElement>(null)
  const open = anchor !== null
  React.useEffect(() => {
    if (!open) return
    const close = () => setAnchor(null)
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close()
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [open])
  return (
    <div ref={ref}>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          if (open) return setAnchor(null)
          const rect = e.currentTarget.getBoundingClientRect()
          setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
        }}
      >
        {busy && <Loader2 className="animate-spin" />}
        {label}
        <ChevronDown className="!size-3" />
      </Button>
      {anchor && (
        <MenuContext.Provider value={() => setAnchor(null)}>
          <div
            role="menu"
            style={{ top: anchor.top, right: anchor.right }}
            className="fixed z-50 flex min-w-[220px] flex-col rounded-lg border bg-popover p-1 shadow-lg animate-rise"
          >
            {children}
          </div>
        </MenuContext.Provider>
      )}
    </div>
  )
}

function MenuItem({
  children,
  hint,
  disabled,
  onSelect,
}: {
  children: React.ReactNode
  hint?: string
  disabled?: boolean
  onSelect: () => void
}) {
  const close = React.useContext(MenuContext)
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        close()
        onSelect()
      }}
      className="flex items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5"
    >
      <span className="inline-flex items-center gap-2">{children}</span>
      {hint && <span className="font-mono text-[10.5px] text-faint">{hint}</span>}
    </button>
  )
}

function MenuLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to="/registries/$registryId"
      params={{ registryId: to }}
      role="menuitem"
      className="flex items-center justify-between gap-4 rounded-md px-2.5 py-1.5 text-[13px] hover:bg-accent"
    >
      {children}
      <span className="font-mono text-[10.5px] text-faint">registry page</span>
    </Link>
  )
}

function Panel({ id, label, hint, children }: { id?: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 overflow-hidden rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-[18px] py-3.5">
        <span className="label-mono">{label}</span>
        {hint && <span className="text-[12px] text-faint">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Note({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border px-4 py-3.5">
      <span className="label-mono">{label}</span>
      <span className="text-[12.5px] leading-relaxed text-muted-foreground">{children}</span>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-[18px] py-6 text-center text-[13px] text-muted-foreground">{children}</p>
}

function ErrorLine({ message }: { message: string }) {
  return <p className="font-mono text-[12px] text-destructive">{message}</p>
}

const pad = (n: number) => String(n).padStart(2, "0")

/** 相対時刻 ("2d ago" / "in 5d") */
const relative = (at: number, now: number) => {
  const diff = at - now
  const abs = Math.abs(diff)
  const text =
    abs < 60_000
      ? "now"
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)}m`
        : abs < DAY
          ? `${Math.round(abs / 3_600_000)}h`
          : `${Math.round(abs / DAY)}d`
  if (text === "now") return "just now"
  return diff < 0 ? `${text} ago` : `in ${text}`
}

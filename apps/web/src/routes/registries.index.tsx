import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowUpRight, Plus } from "lucide-react"
import * as React from "react"
import { type Listing, ListingBadge, SignalDot, listingOf } from "~/components/listing-badge"
import { buttonVariants } from "~/components/ui/button"
import { REGISTRY_REQUEST_URL } from "~/lib/links"
import { timeAgo } from "~/lib/live"
import { cn } from "~/lib/utils"
import type { RegistryDto } from "~/server/dto"
import { listRegistriesFn } from "~/server/registries"

export const Route = createFileRoute("/registries/")({
  loader: () => listRegistriesFn(),
  component: RegistriesPage,
})

type Filter = "all" | Listing

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "Official", label: "Official" },
  { id: "Shadcn", label: "shadcn/ui" },
  { id: "Community", label: "Community" },
]

/** 並び: shadcn/ui → 公式 → コミュニティ、その中はアイテムの多い順 */
const ORDER: Record<Listing, number> = { Shadcn: 0, Official: 1, Community: 2 }

function RegistriesPage() {
  const registries = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const [filter, setFilter] = React.useState<Filter>("all")

  const rows = React.useMemo(
    () =>
      registries
        .map((r) => ({ registry: r, listing: listingOf(r.listing) }))
        .sort((a, b) => ORDER[a.listing] - ORDER[b.listing] || b.registry.componentCount - a.registry.componentCount),
    [registries],
  )
  const counts = React.useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, Official: 0, Shadcn: 0, Community: 0 }
    for (const r of rows) c[r.listing]++
    return c
  }, [rows])
  const visible = filter === "all" ? rows : rows.filter((r) => r.listing === filter)
  const total = registries.reduce((n, r) => n + r.componentCount, 0)

  return (
    <div className="flex flex-col gap-7 pt-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-2">
          <span className="label-mono">Registries</span>
          <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.04em] sm:text-[40px]">Every registry, one index.</h1>
          <p className="max-w-[620px] text-[15px] leading-relaxed text-muted-foreground">
            <span className="font-mono text-foreground">{registries.length}</span> registries ·{" "}
            <span className="font-mono text-foreground">{total.toLocaleString("en-US")}</span> items. Each one re-syncs every 7 days; changed items are rebuilt and
            re-captured.
          </p>
        </div>
        {user?.isAdmin && (
          <Link to="/admin/registries/new" className={buttonVariants()}>
            <Plus /> Register
          </Link>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by listing">
        {FILTERS.map((f) => {
          const active = filter === f.id
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setFilter(f.id)}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors",
                active ? "border-signal/60 bg-signal/10 text-foreground" : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {f.label}
              <span className={cn("font-mono text-[11px]", active ? "text-signal-foreground" : "text-faint")}>{counts[f.id]}</span>
            </button>
          )
        })}
      </div>

      {visible.length === 0 ? (
        <div className="stage flex flex-col items-center gap-2 rounded-[14px] border px-6 py-16 text-center">
          <span className="text-sm font-medium">No registries here yet</span>
          <span className="max-w-sm text-[13px] text-muted-foreground">
            {filter === "Official"
              ? "Registries from the official shadcn directory are imported automatically, highest-ranked first."
              : "Request one on GitHub and it will show up here once it's imported."}
          </span>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[14px] border bg-card">
          <div className="hidden grid-cols-[minmax(0,1fr)_120px_200px] gap-6 border-b px-5 py-2.5 md:grid">
            <span className="label-mono">Registry</span>
            <span className="label-mono text-right">Items</span>
            <span className="label-mono">Sync</span>
          </div>
          <ul>
            {visible.map(({ registry, listing }) => (
              <li key={registry.id} className="border-b last:border-b-0">
                <RegistryRow registry={registry} listing={listing} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <RequestCta />
    </div>
  )
}

function RegistryRow({ registry, listing }: { registry: RegistryDto; listing: Listing }) {
  const title = registry.namespace ?? registry.name
  return (
    <Link
      to="/registries/$registryId"
      params={{ registryId: registry.id }}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1.5 px-5 py-3.5 transition-colors hover:bg-accent/50 md:grid-cols-[minmax(0,1fr)_120px_200px]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="truncate font-mono text-[15px] font-medium tracking-tight">{title}</span>
          <ListingBadge listing={listing} />
        </div>
        <span className="truncate font-mono text-[11.5px] text-faint">{hostPath(registry.homepage ?? registry.indexUrl)}</span>
      </div>
      <span className="text-right font-mono text-sm tabular-nums">
        {registry.componentCount.toLocaleString("en-US")}
        <span className="ml-1 text-[11px] text-faint md:hidden">items</span>
      </span>
      <div className="col-span-2 md:col-span-1">
        <SyncState status={registry.status} />
      </div>
    </Link>
  )
}

const hostPath = (url: string) => {
  try {
    const u = new URL(url)
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`
  } catch {
    return url
  }
}

function SyncState({ status }: { status: RegistryDto["status"] }) {
  const base = "inline-flex items-center gap-2 font-mono text-[12px]"
  switch (status._tag) {
    case "Active":
      return (
        <span className={cn(base, "text-muted-foreground")} suppressHydrationWarning>
          <span className="size-[7px] rounded-full bg-foreground/70" />
          synced {timeAgo(status.lastSyncedAt)}
        </span>
      )
    case "Syncing":
      return (
        <span className={cn(base, "text-signal-foreground")}>
          <SignalDot pulse />
          syncing
        </span>
      )
    case "Pending":
      return (
        <span className={cn(base, "text-muted-foreground")}>
          <span className="size-[7px] rounded-full border border-faint" />
          queued
        </span>
      )
    case "Failed":
      return (
        <span className={cn(base, "text-destructive")} title={status.reason}>
          <span className="size-[7px] rounded-full bg-destructive" />
          sync failed
        </span>
      )
    case "Disabled":
      return (
        <span className={cn(base, "text-faint")} title={status.reason}>
          <span className="size-[7px] rounded-full bg-muted-foreground/40" />
          disabled
        </span>
      )
  }
}

/** 登録は運営者だけが行う。公式ディレクトリのものは自動、それ以外は GitHub Issues で受け付ける */
function RequestCta() {
  return (
    <div className="stage flex flex-col justify-between gap-5 rounded-[14px] border p-5 sm:flex-row sm:items-center sm:p-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-[15px] font-medium">Missing a registry?</span>
        <p className="max-w-[640px] text-[13.5px] leading-relaxed text-muted-foreground">
          Registries listed in the official shadcn directory are imported automatically, highest-ranked first — no need to ask. For anything else, open a request on
          GitHub with the registry URL.
        </p>
      </div>
      <a href={REGISTRY_REQUEST_URL} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline" }), "shrink-0")}>
        Request a registry <ArrowUpRight />
      </a>
    </div>
  )
}

import { Link } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { splitComponentId, timeAgo, useLiveSummary } from "~/lib/live"
import { SignalDot } from "./listing-badge"

/**
 * 画面下の「いま作っているもの」。進行中が無く、直近にも撮れたものが無ければ出さない
 */
export function LiveTicker() {
  const summary = useLiveSummary()
  if (!summary) return null
  const building = summary.active[0]
  const captured = summary.captured[0]
  if (!building && !captured) return null
  return (
    <div className="pointer-events-none sticky bottom-4 z-30 mt-10 flex justify-center">
      <Link
        to="/live"
        className="pointer-events-auto flex h-11 w-full max-w-[820px] items-center gap-3.5 rounded-xl border bg-card/90 pr-2 pl-4 text-[13px] shadow-lg shadow-black/20 backdrop-blur-md"
      >
        <span className="inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-signal-foreground">
          <SignalDot pulse />
          LIVE
        </span>
        {building && (
          <>
            <span className="truncate font-mono text-xs">@{splitComponentId(building.componentId).registryId}/{splitComponentId(building.componentId).name}</span>
            <span className="hidden truncate text-muted-foreground sm:inline">{building.latest.message}</span>
          </>
        )}
        {building && captured && <span className="hidden h-4 w-px bg-border md:block" />}
        {captured?.componentId && (
          <span className="hidden min-w-0 items-center gap-2 md:flex">
            <span className="truncate font-mono text-xs">@{splitComponentId(captured.componentId).registryId}/{splitComponentId(captured.componentId).name}</span>
            <span className="shrink-0 text-muted-foreground">captured {timeAgo(captured.at)}</span>
          </span>
        )}
        <span className="ml-auto inline-flex h-7.5 shrink-0 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-foreground">
          Watch <ArrowRight className="size-3" />
        </span>
      </Link>
    </div>
  )
}

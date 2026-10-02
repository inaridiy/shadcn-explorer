import { Check } from "lucide-react"
import { cn } from "~/lib/utils"

export type Listing = "Official" | "Shadcn" | "Community"

/** RegistryDto.listing → バッジ。core の listingBadge と同じ規則 (クライアントに effect を持ち込まないため写す) */
export const listingOf = (listing: { readonly _tag: string; readonly listed?: boolean }): Listing =>
  listing._tag === "Official" ? (listing.listed ? "Official" : "Community") : listing._tag === "Shadcn" ? "Shadcn" : "Community"

/**
 * レジストリの出自のバッジ。Official = shadcn 公式ディレクトリに載っている (自動で取り込む)、
 * shadcn/ui = ui.shadcn.com 自身、Community = 申請で取り込んだもの
 */
export function ListingBadge({ listing, className }: { listing: Listing; className?: string }) {
  const base = "inline-flex h-5 shrink-0 items-center gap-1 rounded-[5px] px-1.5 font-mono text-[10px] font-semibold tracking-[0.06em]"
  if (listing === "Official")
    return (
      <span className={cn(base, "bg-foreground text-background", className)} title="Listed in the official shadcn registry directory">
        <Check className="size-2.5" strokeWidth={3.5} />
        OFFICIAL
      </span>
    )
  if (listing === "Shadcn")
    return (
      <span className={cn(base, "bg-foreground text-background", className)} title="shadcn/ui itself">
        SHADCN/UI
      </span>
    )
  return (
    <span className={cn(base, "border font-medium text-muted-foreground", className)} title="Added on request, not in the official directory">
      COMMUNITY
    </span>
  )
}

/** カードの名前空間の横に出す小さな印 (公式だけ) */
export function OfficialMark({ listing }: { listing: Listing }) {
  if (listing === "Community") return null
  return (
    <svg aria-label="Official" viewBox="0 0 24 24" className="size-3 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <title>{listing === "Shadcn" ? "shadcn/ui" : "Official"}</title>
      <path d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

/** 生きている印 (橙の点)。pulse で点滅 (視差効果を減らす設定では止まる) */
export function SignalDot({ pulse = false, className }: { pulse?: boolean; className?: string }) {
  return <span className={cn("inline-block size-[7px] shrink-0 rounded-full bg-signal", pulse && "animate-signal", className)} />
}

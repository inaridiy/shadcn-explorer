import { Link } from "@tanstack/react-router"
import { ImageOff, Loader2 } from "lucide-react"
import { cn } from "~/lib/utils"
import type { ComponentCardDto } from "~/server/dto"
import { OfficialMark } from "./listing-badge"

const SOURCE_LABEL: Record<string, string> = {
  keyword: "keyword",
  semantic: "meaning",
  "visual-text": "looks alike",
  "visual-image": "image",
}

/**
 * 静止画 (WebP) と、動き続ける部品なら animated WebP。視差効果を減らす設定の閲覧者と、
 * animated WebP を再生できないブラウザには静止画が出る (JS 不要)。
 */
function Still({ src, motion, alt, className }: { src: string; motion: string | null; alt: string; className: string }) {
  // 読み込めなかった画像の alt を地に出さない (text-transparent)
  if (!motion) return <img src={src} alt={alt} loading="lazy" decoding="async" className={cn(className, "text-transparent")} />
  return (
    <picture className="contents">
      <source media="(prefers-reduced-motion: no-preference)" srcSet={motion} type="image/webp" />
      <img src={src} alt={alt} loading="lazy" decoding="async" className={cn(className, "text-transparent")} />
    </picture>
  )
}

export function Screenshot({ card, className }: { card: ComponentCardDto; className?: string }) {
  if (card.screenshot) {
    const { light, dark, motion } = card.screenshot
    return (
      <div className={cn("relative", className)}>
        <Still src={light} motion={motion?.light ?? null} alt={card.title} className="size-full object-cover dark:hidden" />
        <Still
          src={dark ?? light}
          motion={motion ? (motion.dark ?? motion.light) : null}
          alt={card.title}
          className="hidden size-full object-cover dark:block"
        />
      </div>
    )
  }
  const pending =
    (card.status.preview === "NotCaptured" || card.status.preview === "Built") &&
    card.status.doc !== "Failed" &&
    !["hook", "lib", "file"].includes(card.kind)
  return (
    <div className={cn("stage flex flex-col items-center justify-center gap-2 text-muted-foreground", className)}>
      {pending ? <Loader2 className="size-5 animate-spin" /> : <ImageOff className="size-5" />}
      <span className="font-mono text-[11px]">{pending ? "building preview…" : `${card.kind} · no preview`}</span>
    </div>
  )
}

export function ComponentCard({ card, sources }: { card: ComponentCardDto; sources?: ReadonlyArray<string> }) {
  return (
    <Link
      to="/c/$registryId/$name"
      params={{ registryId: card.registryId, name: card.name }}
      className="group flex flex-col overflow-hidden rounded-[14px] border bg-card transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-ring focus-visible:outline-2 focus-visible:outline-signal"
    >
      {/* スクショは 16:10 のビューポートで撮っているので、余白なしでカードに敷き詰める */}
      <div className="relative aspect-[16/10] w-full overflow-hidden border-b bg-stage">
        <Screenshot card={card} className="size-full" />
        {card.screenshot?.motion && (
          <span className="absolute top-2.5 left-2.5 inline-flex h-5 items-center gap-1.5 rounded-[5px] bg-zinc-950/70 px-1.5 font-mono text-[10px] tracking-[0.06em] text-signal backdrop-blur-sm">
            <span className="size-[5px] rounded-full bg-signal" />
            MOTION
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-medium">{card.title}</h3>
          <span className="shrink-0 font-mono text-[11px] text-faint">{card.kind}</span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
          <span className="truncate">@{card.registryId}</span>
          <OfficialMark listing={card.listing} />
          {card.listing === "Community" && <span className="text-[10px] tracking-wider text-faint">COMMUNITY</span>}
          {sources && sources.length > 0 && (
            <span className="ml-auto flex gap-1">
              {sources.map((s) => (
                <span key={s} className="rounded-[4px] bg-muted px-1 text-[10px] text-muted-foreground">
                  {SOURCE_LABEL[s] ?? s}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>
    </Link>
  )
}

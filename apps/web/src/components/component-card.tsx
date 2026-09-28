import { Link } from "@tanstack/react-router"
import { ImageOff, Loader2 } from "lucide-react"
import { Badge } from "~/components/ui/badge"
import type { ComponentCardDto } from "~/server/dto"

const SOURCE_LABEL: Record<string, string> = {
  keyword: "BM25",
  semantic: "Semantic",
  "visual-text": "Visual",
  "visual-image": "Image",
}

export function Screenshot({ card, className }: { card: ComponentCardDto; className?: string }) {
  if (card.screenshot) {
    return (
      <div className={className}>
        <img src={card.screenshot.light} alt={card.title} loading="lazy" className="size-full object-contain dark:hidden" />
        <img
          src={card.screenshot.dark ?? card.screenshot.light}
          alt={card.title}
          loading="lazy"
          className="hidden size-full object-contain dark:block"
        />
      </div>
    )
  }
  const pending = card.status.preview === "NotCaptured" && card.status.doc !== "Failed" && !["hook", "lib", "file"].includes(card.kind)
  return (
    <div className={`${className ?? ""} flex flex-col items-center justify-center gap-2 text-muted-foreground`}>
      {pending ? <Loader2 className="size-5 animate-spin" /> : <ImageOff className="size-5" />}
      <span className="text-xs">{pending ? "Preview generating…" : `${card.kind} (no preview)`}</span>
    </div>
  )
}

export function ComponentCard({ card, sources }: { card: ComponentCardDto; sources?: ReadonlyArray<string> }) {
  return (
    <Link
      to="/c/$registryId/$name"
      params={{ registryId: card.registryId, name: card.name }}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg"
    >
      <Screenshot card={card} className="aspect-[16/10] w-full border-b bg-muted/30 p-3" />
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold leading-tight group-hover:underline">{card.title}</h3>
          <Badge variant="outline" className="font-mono">
            {card.kind}
          </Badge>
        </div>
        <p className="line-clamp-2 text-sm text-muted-foreground">{card.summary ?? card.description ?? ""}</p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          <Badge variant="secondary" className="font-mono">
            {card.registryId}
          </Badge>
          {sources?.map((s) => (
            <Badge key={s} variant="brand">
              {SOURCE_LABEL[s] ?? s}
            </Badge>
          ))}
        </div>
      </div>
    </Link>
  )
}

import { cn } from "~/lib/utils"

/** 2×2 のタイルの 1 つだけが signal 色のロゴマーク */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={cn("grid size-[22px] grid-cols-2 gap-[2px] rounded-md bg-foreground p-1", className)} aria-hidden>
      <span className="rounded-[1px] bg-background" />
      <span className="rounded-[1px] bg-background" />
      <span className="rounded-[1px] bg-background" />
      <span className="rounded-[1px] bg-signal" />
    </span>
  )
}

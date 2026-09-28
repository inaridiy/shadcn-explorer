import { cn } from "~/lib/utils"
import { CopyButton } from "./copy-button"

export function CodeBlock({ code, title, className }: { code: string; title?: string; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-muted/40", className)}>
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{title ?? ""}</span>
        <CopyButton value={code} />
      </div>
      <pre className="max-h-[480px] overflow-auto p-4 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}

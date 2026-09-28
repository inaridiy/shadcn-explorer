import { Check, Copy } from "lucide-react"
import * as React from "react"
import { Button } from "~/components/ui/button"
import { cn } from "~/lib/utils"

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <Button
      type="button"
      variant={label ? "outline" : "ghost"}
      size={label ? "sm" : "icon"}
      className={cn(label ? "" : "size-7", className)}
      aria-label={label ?? "Copy"}
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check /> : <Copy />}
      {label}
    </Button>
  )
}

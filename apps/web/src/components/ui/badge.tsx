import { type VariantProps, cva } from "class-variance-authority"
import type * as React from "react"
import { cn } from "~/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "text-foreground",
        brand: "border-transparent bg-signal/15 text-signal-foreground",
        signal: "border-transparent bg-signal/15 font-mono text-[10.5px] tracking-wider text-signal-foreground",
        kind: "border-transparent bg-muted font-mono text-[11px] font-normal text-muted-foreground",
        destructive: "border-transparent bg-destructive/15 text-destructive",
        warning: "border-transparent bg-warning/15 text-warning",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

export function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

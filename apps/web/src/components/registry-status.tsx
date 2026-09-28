import { Badge } from "~/components/ui/badge"
import type { RegistryDto } from "~/server/dto"

export function RegistryStatusBadge({ status }: { status: RegistryDto["status"] }) {
  switch (status._tag) {
    case "Pending":
      return <Badge variant="secondary">Pending</Badge>
    case "Syncing":
      return <Badge variant="brand">Syncing…</Badge>
    case "Active":
      return <Badge variant="outline">Active · {status.itemCount} items</Badge>
    case "Failed":
      return (
        <Badge variant="destructive" title={status.reason}>
          Failed
        </Badge>
      )
    case "Disabled":
      return <Badge variant="destructive">Disabled</Badge>
  }
}

export const formatDate = (ms: number) => new Date(ms).toLocaleString("ja-JP", { dateStyle: "medium", timeStyle: "short" })

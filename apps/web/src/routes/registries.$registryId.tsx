import { createFileRoute, useRouter } from "@tanstack/react-router"
import { ExternalLink, Loader2, RefreshCw } from "lucide-react"
import * as React from "react"
import { ComponentCard } from "~/components/component-card"
import { RegistryStatusBadge, formatDate } from "~/components/registry-status"
import { Button } from "~/components/ui/button"
import { getRegistryFn, resyncRegistryFn } from "~/server/registries"

export const Route = createFileRoute("/registries/$registryId")({
  loader: ({ params }) => getRegistryFn({ data: { registryId: params.registryId } }),
  component: RegistryPage,
})

function RegistryPage() {
  const { registry, components } = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)
  const inProgress = registry.status._tag === "Pending" || registry.status._tag === "Syncing" ||
    components.some((c) => c.status.index === "NotIndexed")

  // 同期・エンリッチ中は定期的に再取得して進捗を見せる
  React.useEffect(() => {
    if (!inProgress) return
    const t = setInterval(() => router.invalidate(), 5000)
    return () => clearInterval(t)
  }, [inProgress, router])

  const done = components.filter((c) => c.status.index === "Indexed").length

  return (
    <div className="flex flex-col gap-6 pt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight">
            {registry.namespace ?? registry.name}
            <RegistryStatusBadge status={registry.status} />
          </h1>
          <a href={registry.indexUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
            {registry.indexUrl} <ExternalLink className="size-3" />
          </a>
          <p className="text-sm text-muted-foreground">
            {done}/{components.length} indexed
            {registry.status._tag === "Active" && ` · last synced ${formatDate(registry.status.lastSyncedAt)}`}
            {registry.status._tag === "Failed" && ` · ${registry.status.reason}`}
          </p>
        </div>
        {user && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={async () => {
              setPending(true)
              try {
                await resyncRegistryFn({ data: { registryId: registry.id } })
                setMessage("Re-sync scheduled")
                await router.invalidate()
              } catch (e) {
                setMessage(e instanceof Error ? e.message : String(e))
              } finally {
                setPending(false)
              }
            }}
          >
            {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-sync
          </Button>
        )}
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {components.map((c) => (
          <ComponentCard key={c.id} card={c} />
        ))}
      </div>
    </div>
  )
}

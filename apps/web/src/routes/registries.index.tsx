import { Link, createFileRoute } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { RegistryStatusBadge } from "~/components/registry-status"
import { buttonVariants } from "~/components/ui/button"
import { listRegistriesFn } from "~/server/registries"

export const Route = createFileRoute("/registries/")({
  loader: () => listRegistriesFn(),
  component: RegistriesPage,
})

function RegistriesPage() {
  const registries = Route.useLoaderData()
  return (
    <div className="flex flex-col gap-6 pt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Registries</h1>
          <p className="text-muted-foreground">shadcn registries indexed by Shadcn Explorer.</p>
        </div>
        <Link to="/registries/new" className={buttonVariants()}>
          <Plus /> Register
        </Link>
      </div>
      {registries.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">No registries yet.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {registries.map((r) => (
            <Link
              key={r.id}
              to="/registries/$registryId"
              params={{ registryId: r.id }}
              className="flex flex-col gap-2 rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{r.namespace ?? r.name}</span>
                <RegistryStatusBadge status={r.status} />
              </div>
              <span className="truncate font-mono text-xs text-muted-foreground">{r.indexUrl}</span>
              <span className="text-sm text-muted-foreground">{r.componentCount} components</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

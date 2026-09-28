import { Link, createFileRoute } from "@tanstack/react-router"
import { KeyRound, Loader2 } from "lucide-react"
import * as React from "react"
import { CodeBlock } from "~/components/code-block"
import { buttonVariants, Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { authClient } from "~/lib/auth-client"
import { usageSummaryFn } from "~/server/usage"

export const Route = createFileRoute("/settings")({
  loader: () => usageSummaryFn(),
  component: SettingsPage,
})

function ApiKeys() {
  const [keys, setKeys] = React.useState<Array<{ id: string; name: string | null; start: string | null }>>([])
  const [created, setCreated] = React.useState<string | null>(null)
  const [name, setName] = React.useState("my-agent")
  const [pending, setPending] = React.useState(false)

  const load = React.useCallback(async () => {
    const res = await authClient.apiKey.list()
    const data = res.data as unknown
    const list = (Array.isArray(data) ? data : ((data as { apiKeys?: unknown[] } | null)?.apiKeys ?? [])) as typeof keys
    setKeys(list)
  }, [])
  React.useEffect(() => void load(), [load])

  return (
    <div className="flex flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          setPending(true)
          const res = await authClient.apiKey.create({ name })
          setPending(false)
          if (res.data) {
            setCreated(res.data.key)
            await load()
          }
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name" />
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <KeyRound />} Create key
        </Button>
      </form>
      {created && <CodeBlock code={created} title="Copy now — it will not be shown again" />}
      <ul className="flex flex-col gap-1 text-sm">
        {keys.map((k) => (
          <li key={k.id} className="flex justify-between rounded-md border px-3 py-2">
            <span>{k.name ?? "(unnamed)"}</span>
            <span className="font-mono text-muted-foreground">{k.start}…</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SettingsPage() {
  const usage = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const origin = typeof window === "undefined" ? "https://shadcn-explorer.example.com" : window.location.origin
  const ratio = Math.min(1, usage.totalUsd / usage.budgetUsd)

  return (
    <div className="flex flex-col gap-6 pt-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">API & MCP</h1>
        <p className="text-muted-foreground">Let your coding agent search every shadcn registry by itself.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>API keys</CardTitle>
            <CardDescription>Optional. Anonymous REST/MCP reads are limited to 30 requests / minute per IP; a key raises it to 60 / minute per key and is required for writes.</CardDescription>
          </CardHeader>
          <CardContent>
            {user ? (
              <ApiKeys />
            ) : (
              <Link to="/login" search={{ redirect: "/settings" }} className={buttonVariants({ variant: "outline" })}>
                Sign in to create keys
              </Link>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>This month's processing cost</CardTitle>
            <CardDescription>Coding agent, Browser Rendering and embeddings. Budget: ${usage.budgetUsd}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-brand" style={{ width: `${ratio * 100}%` }} />
            </div>
            <p className="text-2xl font-semibold">${usage.totalUsd.toFixed(2)}</p>
            <ul className="text-sm text-muted-foreground">
              {usage.categories.map((c) => (
                <li key={c.category} className="flex justify-between">
                  <span>{c.category}</span>
                  <span>
                    ${c.usd.toFixed(3)} · {c.count} runs
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>MCP</CardTitle>
          <CardDescription>Tools: search_components, get_component, list_registries</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CodeBlock title="Claude Code" code={`claude mcp add --transport http shadcn-explorer ${origin}/mcp`} />
          <CodeBlock title="Claude Code (higher limits)" code={`claude mcp add --transport http shadcn-explorer ${origin}/mcp --header "x-api-key: sce_..."`} />
          <CodeBlock
            title=".mcp.json / .cursor/mcp.json"
            code={JSON.stringify({ mcpServers: { "shadcn-explorer": { type: "http", url: `${origin}/mcp`, headers: { "x-api-key": "sce_..." } } } }, null, 2)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>REST API</CardTitle>
        </CardHeader>
        <CardContent>
          <CodeBlock
            title="curl"
            code={`curl -H "x-api-key: sce_..." "${origin}/api/v1/search?q=glowing%20button&mode=hybrid&kind=ui"
curl -H "x-api-key: sce_..." "${origin}/api/v1/components/<registry>/<name>"
curl -H "x-api-key: sce_..." -F image=@design.png "${origin}/api/v1/search/image"`}
          />
        </CardContent>
      </Card>
    </div>
  )
}

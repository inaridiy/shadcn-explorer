import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router"
import { ArrowRight, CircleCheck, Loader2, TriangleAlert } from "lucide-react"
import * as React from "react"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { previewRegistrationFn, registerRegistryFn } from "~/server/registries"

export const Route = createFileRoute("/registries/new")({
  beforeLoad: ({ context }) => {
    if (!context.user) throw redirect({ to: "/login", search: { redirect: "/registries/new" } })
  },
  component: NewRegistryPage,
})

type Preview = Extract<Awaited<ReturnType<typeof previewRegistrationFn>>, { ok: true }>["preview"]

/**
 * 登録フロー
 *   1. URL / @namespace を入力 → 解決 (registry.json 探索・公式ディレクトリ照合)
 *   2. 確認: アイテム数・種別・ヘルス・初回エンリッチの見積もりコスト
 *   3. 登録 → Workflow で同期 → エンリッチ (ドキュメント生成・スクショ・インデックス)
 */
function NewRegistryPage() {
  const navigate = useNavigate()
  const [input, setInput] = React.useState("")
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<"preview" | "register" | null>(null)

  const check = async (e: React.FormEvent) => {
    e.preventDefault()
    setPending("preview")
    setError(null)
    setPreview(null)
    const result = await previewRegistrationFn({ data: { input } })
    setPending(null)
    if (result.ok) setPreview(result.preview)
    else setError(result.error.message)
  }

  const register = async () => {
    setPending("register")
    const result = await registerRegistryFn({ data: { input: preview?.indexUrl ?? input } })
    setPending(null)
    if (result.ok) navigate({ to: "/registries/$registryId", params: { registryId: result.registry.id } })
    else setError(result.error.message)
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 pt-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Register a registry</h1>
        <p className="text-muted-foreground">
          Paste a registry URL (<code className="font-mono text-xs">https://example.com/r/registry.json</code>, an item template{" "}
          <code className="font-mono text-xs">https://example.com/r/{"{name}"}.json</code>, or just the site URL) or a namespace like{" "}
          <code className="font-mono text-xs">@magicui</code>.
        </p>
      </div>
      <form onSubmit={check} className="flex gap-2">
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="@acme or https://acme.dev" className="h-10" />
        <Button type="submit" size="lg" disabled={pending !== null || input.trim() === ""}>
          {pending === "preview" ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          Check
        </Button>
      </form>
      {error && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="size-4" />
          {error}
        </p>
      )}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CircleCheck className="size-5 text-brand" />
              {preview.namespace ?? preview.name}
              {preview.directoryHealth && <Badge variant="outline">directory: {preview.directoryHealth}</Badge>}
            </CardTitle>
            <CardDescription className="font-mono text-xs">{preview.indexUrl}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1.5">
              <Badge>{preview.itemCount} items</Badge>
              {Object.entries(preview.kinds).map(([k, n]) => (
                <Badge key={k} variant="secondary" className="font-mono">
                  {k} × {n}
                </Badge>
              ))}
            </div>
            <ul className="grid gap-1 text-sm">
              {preview.sampleItems.map((i) => (
                <li key={i.name} className="truncate">
                  <span className="font-mono">{i.name}</span> <span className="text-muted-foreground">— {i.description}</span>
                </li>
              ))}
            </ul>
            <div className="rounded-lg bg-muted/50 p-3 text-sm">
              Estimated initial processing cost (docs by coding agent, screenshots, embeddings):{" "}
              <strong>${preview.estimatedInitialCostUsd.toFixed(2)}</strong>. Re-syncs only process changed items.
            </div>
            {preview.alreadyRegistered ? (
              <Button variant="outline" onClick={() => navigate({ to: "/registries/$registryId", params: { registryId: preview.alreadyRegistered! } })}>
                Already registered — open
              </Button>
            ) : preview.tooLarge ? (
              <p className="text-sm text-destructive">This registry exceeds the per-registry item limit.</p>
            ) : (
              <Button onClick={register} disabled={pending !== null}>
                {pending === "register" && <Loader2 className="animate-spin" />}
                Register and start indexing
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

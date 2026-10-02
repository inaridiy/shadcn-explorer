import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ArrowRight, Loader2, TriangleAlert } from "lucide-react"
import * as React from "react"
import { ListingBadge } from "~/components/listing-badge"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { cn } from "~/lib/utils"
import { previewRegistrationFn, registerRegistryFn } from "~/server/registries"

type Via = "github" | "email" | "operator"

interface NewRegistrySearch {
  readonly input?: string | undefined
  readonly reference?: string | undefined
  readonly via?: Via | undefined
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined)

/** 運営者だけ (/admin のレイアウトで確認済み)。申請から来たときは ?input=&reference=&via= で入力を埋める */
export const Route = createFileRoute("/admin/registries/new")({
  validateSearch: (search: Record<string, unknown>): NewRegistrySearch => ({
    input: str(search.input, 500),
    reference: str(search.reference, 500),
    via: search.via === "github" || search.via === "email" || search.via === "operator" ? search.via : undefined,
  }),
  component: NewRegistryPage,
})

type Preview = Extract<Awaited<ReturnType<typeof previewRegistrationFn>>, { ok: true }>["preview"]

/**
 * 登録フロー (運営者のみ。一般ユーザーからの追加は GitHub Issues・メールで受け付ける)
 *   1. URL / @namespace を入力 → 解決 (registry.json 探索・公式ディレクトリ照合)
 *   2. 確認: アイテム数・種別・ヘルス・初回エンリッチの見積もりコスト
 *   3. 出自 (Community / shadcn/ui) と申請の経路を付けて登録 → Workflow で同期 → エンリッチ
 * 公式ディレクトリに載っているものは、ここで何を選んでも次のディレクトリ同期で Official になる
 */
function NewRegistryPage() {
  const navigate = useNavigate()
  const search = Route.useSearch()
  const [input, setInput] = React.useState(search.input ?? "")
  const [listing, setListing] = React.useState<"community" | "shadcn">("community")
  const [via, setVia] = React.useState<Via>(search.via ?? (search.reference ? "github" : "operator"))
  const [reference, setReference] = React.useState(search.reference ?? "")
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState<"preview" | "register" | null>(null)

  const check = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (input.trim() === "") return
    setPending("preview")
    setError(null)
    setPreview(null)
    const result = await previewRegistrationFn({ data: { input } })
    setPending(null)
    if (result.ok) setPreview(result.preview)
    else setError(result.error.message)
  }

  // 申請から来たときは確認まで自動で進める (登録は押すまでしない)
  const autoChecked = React.useRef(false)
  React.useEffect(() => {
    if (autoChecked.current || !search.input) return
    autoChecked.current = true
    void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const register = async () => {
    setPending("register")
    setError(null)
    const result = await registerRegistryFn({
      data: {
        input: preview?.indexUrl ?? input,
        listing,
        requestedVia: via,
        reference: listing === "community" && reference.trim() !== "" ? reference.trim() : undefined,
      },
    })
    setPending(null)
    if (result.ok) navigate({ to: "/registries/$registryId", params: { registryId: result.registry.id } })
    else setError(result.error.message)
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-7 pt-9">
      <div className="flex flex-col gap-1.5">
        <Link to="/admin" className="label-mono inline-flex w-fit items-center gap-1 hover:text-foreground">
          <ArrowLeft className="size-3" /> Admin
        </Link>
        <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.04em]">Register a registry</h1>
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          Paste a registry URL (<code className="font-mono text-[12.5px]">https://example.com/r/registry.json</code>, an item template{" "}
          <code className="font-mono text-[12.5px]">https://example.com/r/{"{name}"}.json</code>, or just the site URL) or a namespace like{" "}
          <code className="font-mono text-[12.5px]">@magicui</code>.
        </p>
      </div>

      <form onSubmit={check} className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="@acme or https://acme.dev"
          className="h-10 font-mono"
          aria-label="Registry"
        />
        <Button type="submit" size="lg" disabled={pending !== null || input.trim() === ""}>
          {pending === "preview" ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          Check
        </Button>
      </form>

      <section className="flex flex-col gap-5 rounded-[14px] border bg-card p-5">
        <Field label="Listing" hint="Registries in the official shadcn directory become Official automatically on the next directory sync.">
          <Segmented
            value={listing}
            onChange={setListing}
            options={[
              { value: "community", label: <ListingBadge listing="Community" />, description: "Added on request" },
              { value: "shadcn", label: <ListingBadge listing="Shadcn" />, description: "ui.shadcn.com itself" },
            ]}
          />
        </Field>
        {listing === "community" && (
          <>
            <Field label="Requested via">
              <Segmented
                value={via}
                onChange={setVia}
                options={[
                  { value: "github", label: "GitHub issue" },
                  { value: "email", label: "Email" },
                  { value: "operator", label: "Operator" },
                ]}
              />
              <span
                aria-disabled="true"
                title="Paid checkout (Stripe) is not implemented yet"
                className="inline-flex h-8 w-fit items-center rounded-lg border border-dashed px-2 font-mono text-[11px] text-faint"
              >
                CHECKOUT · COMING LATER
              </span>
            </Field>
            <Field label="Reference" hint={via === "github" ? "The request issue URL" : via === "email" ? "Sender or message id" : "Optional note"}>
              <Input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                maxLength={500}
                placeholder={via === "github" ? "https://github.com/inaridiy/shadcn-explorer/issues/…" : ""}
                className="font-mono text-[13px]"
              />
            </Field>
          </>
        )}
      </section>

      {error && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          {error}
        </p>
      )}

      {pending === "preview" && <div className="skeleton h-48 rounded-[14px]" />}

      {preview && (
        <section className="flex flex-col gap-4 rounded-[14px] border bg-card p-5 animate-rise">
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[17px] font-medium">{preview.namespace ?? preview.name}</span>
              {preview.directoryHealth && <Badge variant="kind">directory: {preview.directoryHealth}</Badge>}
            </div>
            <span className="truncate font-mono text-[12px] text-faint">{preview.indexUrl}</span>
          </div>
          {preview.directoryHealth && (
            <p className="text-[12.5px] text-muted-foreground">
              Listed in the official directory: it will be labeled <ListingBadge listing="Official" className="mx-0.5 align-middle" /> regardless of
              the listing chosen above.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Badge>{preview.itemCount} items</Badge>
            {Object.entries(preview.kinds).map(([k, n]) => (
              <Badge key={k} variant="kind">
                {k} × {n}
              </Badge>
            ))}
          </div>
          <ul className="grid gap-1 text-[13px]">
            {preview.sampleItems.map((i) => (
              <li key={i.name} className="truncate">
                <span className="font-mono">{i.name}</span> <span className="text-muted-foreground">— {i.description}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-baseline justify-between gap-4 rounded-lg bg-muted px-3.5 py-3 text-[13px]">
            <span className="text-muted-foreground">Estimated initial processing (docs, demo builds, screenshots, embeddings). Re-syncs only process changed items.</span>
            <span className="shrink-0 font-mono text-[15px]">${preview.estimatedInitialCostUsd.toFixed(2)}</span>
          </div>
          {preview.alreadyRegistered ? (
            <Button
              variant="outline"
              onClick={() => navigate({ to: "/registries/$registryId", params: { registryId: preview.alreadyRegistered! } })}
            >
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
        </section>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="label-mono">{label}</span>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: ReadonlyArray<{ value: T; label: React.ReactNode; description?: string }>
}) {
  return (
    <div role="radiogroup" className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/50 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md px-3 text-[13px] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-signal/40",
            value === o.value ? "bg-card text-foreground shadow-xs ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.description && <span className="text-[11.5px] text-faint">{o.description}</span>}
        </button>
      ))}
    </div>
  )
}

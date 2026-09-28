import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { ImageUp, Loader2, Search, X } from "lucide-react"
import * as React from "react"
import { Schema } from "effect"
import { ComponentKind, SearchMode } from "@shadcn-explorer/core/domain"
import { ComponentCard } from "~/components/component-card"
import { Button } from "~/components/ui/button"
import { Input } from "~/components/ui/input"
import { cn } from "~/lib/utils"
import { browseComponentsFn } from "~/server/components"
import type { SearchHitDto } from "~/server/dto"
import { searchByImageFn, searchFn } from "~/server/search"

const SearchParams = Schema.Struct({
  q: Schema.optional(Schema.String),
  mode: Schema.optional(SearchMode),
  kind: Schema.optional(ComponentKind),
})

const MODES: ReadonlyArray<{ value: SearchMode; label: string; hint: string }> = [
  { value: "hybrid", label: "Hybrid", hint: "BM25 + semantic + visual (RRF)" },
  { value: "keyword", label: "Keyword", hint: "BM25 full-text" },
  { value: "semantic", label: "Semantic", hint: "AI Search vector" },
  { value: "visual", label: "Visual", hint: "Gemini multimodal: text → screenshots" },
]
const KINDS: ReadonlyArray<ComponentKind> = ["ui", "component", "block", "page", "hook", "theme"]
const EXAMPLES = ["かっこいいボタン", "glassmorphism card", "animated gradient text", "sortable data table", "pricing section"]

export const Route = createFileRoute("/")({
  validateSearch: (input) => Schema.decodeUnknownSync(SearchParams)(input, { onExcessProperty: "ignore" }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const kinds = deps.kind ? [deps.kind] : undefined
    if (deps.q && deps.q.trim()) {
      const result = await searchFn({ data: { q: deps.q, mode: deps.mode ?? "hybrid", ...(kinds ? { kinds } : {}) } })
      return { type: "search" as const, hits: result.hits, warnings: result.warnings }
    }
    const cards = await browseComponentsFn({ data: { ...(kinds ? { kinds } : {}) } })
    return { type: "browse" as const, hits: cards.map((c) => ({ ...c, score: 0, sources: [] }) as SearchHitDto), warnings: [] }
  },
  component: SearchPage,
})

function SearchPage() {
  const search = Route.useSearch()
  const data = Route.useLoaderData()
  const navigate = useNavigate({ from: "/" })
  const [text, setText] = React.useState(search.q ?? "")
  const [imageResult, setImageResult] = React.useState<{ preview: string; hits: ReadonlyArray<SearchHitDto> } | null>(null)
  const [imageLoading, setImageLoading] = React.useState(false)
  const [imageError, setImageError] = React.useState<string | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => setText(search.q ?? ""), [search.q])

  const runImageSearch = async (file: File) => {
    setImageLoading(true)
    setImageError(null)
    try {
      const form = new FormData()
      form.set("image", file)
      const result = await searchByImageFn({ data: form })
      setImageResult({ preview: URL.createObjectURL(file), hits: result.hits })
    } catch (e) {
      setImageError(e instanceof Error ? e.message : String(e))
    } finally {
      setImageLoading(false)
    }
  }

  const hits = imageResult?.hits ?? data.hits
  const mode = search.mode ?? "hybrid"

  return (
    <div className="flex flex-col gap-8 pt-12">
      <section className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Every shadcn registry, <span className="text-brand">one search.</span>
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Describe what you want — or paste a screenshot. We search components across all registered registries with
          BM25, semantic and multimodal (Gemini) search.
        </p>
        <form
          className="mt-2 flex w-full max-w-2xl items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setImageResult(null)
            navigate({ search: (prev) => ({ ...prev, q: text || undefined }) })
          }}
          onPaste={(e) => {
            const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"))
            if (file) {
              e.preventDefault()
              void runImageSearch(file)
            }
          }}
        >
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="e.g. かっこいいボタン / shiny CTA button / paste an image"
              className="h-12 pl-9 text-base"
              autoFocus
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void runImageSearch(file)
              e.target.value = ""
            }}
          />
          <Button type="button" variant="outline" size="lg" className="h-12" onClick={() => fileRef.current?.click()} title="Search by image">
            {imageLoading ? <Loader2 className="animate-spin" /> : <ImageUp />}
          </Button>
          <Button type="submit" size="lg" className="h-12">
            Search
          </Button>
        </form>
        <div className="flex flex-wrap justify-center gap-2 text-sm">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="rounded-full border px-3 py-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setImageResult(null)
                navigate({ search: (prev) => ({ ...prev, q: ex }) })
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div className="inline-flex rounded-lg bg-muted p-[3px]">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              title={m.hint}
              onClick={() => navigate({ search: (prev) => ({ ...prev, mode: m.value === "hybrid" ? undefined : m.value }) })}
              className={cn(
                "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground",
                mode === m.value && "bg-background text-foreground shadow-sm",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => navigate({ search: (prev) => ({ ...prev, kind: prev.kind === k ? undefined : k }) })}
              className={cn(
                "rounded-md border px-2.5 py-1 font-mono text-xs text-muted-foreground",
                search.kind === k && "border-foreground bg-foreground text-background",
              )}
            >
              {k}
            </button>
          ))}
        </div>
      </section>

      {imageResult && (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
          <img src={imageResult.preview} alt="query" className="h-12 rounded border object-cover" />
          <span>Components that look like your image</span>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={() => setImageResult(null)} aria-label="Clear image search">
            <X />
          </Button>
        </div>
      )}
      {imageError && <p className="text-sm text-destructive">{imageError}</p>}
      {data.warnings.length > 0 && (
        <p className="text-xs text-muted-foreground">Some search backends were unavailable: {data.warnings.join(" / ")}</p>
      )}

      {hits.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground">
          {data.type === "search" || imageResult ? "No components found." : "No components yet. Register a registry to get started."}
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {hits.map((hit) => (
            <ComponentCard key={hit.id} card={hit} sources={hit.sources} />
          ))}
        </section>
      )}
    </div>
  )
}

import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Check, Loader2, Search, X } from "lucide-react"
import * as React from "react"
import { Schema } from "effect"
import { ComponentKind, SearchMode } from "@shadcn-explorer/core/domain"
import { ComponentCard } from "~/components/component-card"
import { SignalDot } from "~/components/listing-badge"
import { LiveTicker } from "~/components/live-ticker"
import { Button } from "~/components/ui/button"
import { useLiveSummary } from "~/lib/live"
import { cn } from "~/lib/utils"
import { browseComponentsFn } from "~/server/components"
import type { ComponentCardDto, SearchHitDto } from "~/server/dto"
import { listRegistriesFn } from "~/server/registries"
import { searchFn } from "~/server/search"
import { type SponsorSlot, sponsorSlotFn } from "~/server/site"

/**
 * ホーム = ギャラリー (v0.7)。
 * - 何も指定しなければ、プレビューのあるものをレジストリをまたいで混ぜて並べる (keyset ページング)
 * - カテゴリは決めたキーワードでの検索 (BM25、埋め込みを待たないので速い)
 * - 自由入力の検索は、キーワードの一致を SSR で先に出し、意味・見た目で近いものは下の別枠に後から足す
 *   (先に出た並びは組み替えない)
 */
const SearchParams = Schema.Struct({
  q: Schema.optional(Schema.String),
  /** 明示したときだけ使う (既定はキーワード → 後から意味・見た目) */
  mode: Schema.optional(SearchMode),
  kind: Schema.optional(ComponentKind),
  cat: Schema.optional(Schema.String),
  motion: Schema.optional(Schema.Boolean),
  official: Schema.optional(Schema.Boolean),
})

const CATEGORIES: ReadonlyArray<{ readonly id: string; readonly label: string; readonly query: string }> = [
  { id: "buttons", label: "Buttons", query: "button" },
  { id: "cards", label: "Cards", query: "card" },
  { id: "heroes", label: "Heroes", query: "hero section" },
  { id: "text", label: "Text effects", query: "text animation" },
  { id: "backgrounds", label: "Backgrounds", query: "background" },
  { id: "pricing", label: "Pricing", query: "pricing" },
  { id: "forms", label: "Forms", query: "form input" },
  { id: "charts", label: "Charts", query: "chart" },
  { id: "dialogs", label: "Dialogs", query: "dialog modal" },
  { id: "navigation", label: "Navigation", query: "navbar navigation menu" },
]
const KINDS: ReadonlyArray<ComponentKind> = ["ui", "component", "block", "page", "theme"]

export const Route = createFileRoute("/")({
  validateSearch: (input) => Schema.decodeUnknownSync(SearchParams)(input, { onExcessProperty: "ignore" }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const kinds = deps.kind ? [deps.kind] : undefined
    const category = CATEGORIES.find((c) => c.id === deps.cat)
    const query = deps.q?.trim() || category?.query
    const [registries, sponsor] = await Promise.all([listRegistriesFn(), query ? Promise.resolve(null) : sponsorSlotFn()])
    const totals = {
      components: registries.reduce((sum, r) => sum + r.componentCount, 0),
      registries: registries.length,
    }
    if (query) {
      const result = await searchFn({ data: { q: query, mode: deps.mode ?? "keyword", ...(kinds ? { kinds } : {}) } })
      return { type: "search" as const, query, hits: result.hits, next: null, warnings: result.warnings, totals, sponsor: null }
    }
    const page = await browseComponentsFn({
      data: { ...(kinds ? { kinds } : {}), ...(deps.motion ? { motionOnly: true } : {}), ...(deps.official ? { officialOnly: true } : {}) },
    })
    return {
      type: "browse" as const,
      query: null,
      hits: page.cards.map((c): SearchHitDto => ({ ...c, score: 0, sources: [] })),
      next: page.next,
      warnings: [],
      totals,
      sponsor,
    }
  },
  component: HomePage,
})

function Stat({ value, label, signal = false }: { value: React.ReactNode; label: React.ReactNode; signal?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={cn("font-mono text-[26px] font-medium tracking-tight tabular-nums", signal && "text-signal-foreground")}>{value}</span>
      <span className="label-mono inline-flex items-center gap-1.5">{label}</span>
    </div>
  )
}

function FacetButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-lg border bg-card px-3 text-[13px] font-medium transition-colors",
        pressed ? "border-foreground bg-muted" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

function SponsorCard({ sponsor }: { sponsor: SponsorSlot }) {
  return (
    <a
      href={sponsor.href}
      target="_blank"
      rel="sponsored noopener"
      className="group flex flex-col overflow-hidden rounded-[14px] border border-dashed border-faint bg-card transition-colors hover:border-foreground"
    >
      <div className="stage relative aspect-[16/10] w-full overflow-hidden border-b border-dashed">
        {sponsor.image && <img src={sponsor.image} alt={sponsor.title} loading="lazy" className="size-full object-cover" />}
      </div>
      <div className="flex flex-col gap-1.5 px-3.5 pt-3 pb-3.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-medium">{sponsor.title}</h3>
          <span className="inline-flex h-5 items-center rounded-[5px] border border-dashed border-faint px-1.5 font-mono text-[10px] tracking-[0.06em] text-muted-foreground">
            SPONSORED
          </span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">{sponsor.registry}</span>
      </div>
    </a>
  )
}

function HomePage() {
  const search = Route.useSearch()
  const data = Route.useLoaderData()
  const navigate = useNavigate({ from: "/" })
  const live = useLiveSummary()
  const [text, setText] = React.useState(search.q ?? "")
  React.useEffect(() => setText(search.q ?? ""), [search.q])

  // ギャラリーの続き (keyset)。条件が変わったら捨てる
  const [more, setMore] = React.useState<{ hits: ReadonlyArray<SearchHitDto>; next: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = React.useState(false)
  React.useEffect(() => setMore(null), [data])
  const next = more ? more.next : data.next
  const loadMore = React.useCallback(async () => {
    if (!next || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await browseComponentsFn({
        data: {
          ...(search.kind ? { kinds: [search.kind] } : {}),
          ...(search.motion ? { motionOnly: true } : {}),
          ...(search.official ? { officialOnly: true } : {}),
          after: next,
        },
      })
      setMore((prev) => ({
        hits: [...(prev?.hits ?? []), ...page.cards.map((c): SearchHitDto => ({ ...c, score: 0, sources: [] }))],
        next: page.next,
      }))
    } finally {
      setLoadingMore(false)
    }
  }, [next, loadingMore, search.kind, search.motion, search.official])

  // 画面の下に近づいたら続きを読む
  const sentinel = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const el = sentinel.current
    if (!el || !next) return
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void loadMore(), { rootMargin: "800px" })
    observer.observe(el)
    return () => observer.disconnect()
  }, [next, loadMore])

  // 自由入力の検索: キーワードの一致 (SSR 済み) の下に、意味・見た目で近いものを後から足す
  const [similar, setSimilar] = React.useState<{ query: string; hits: ReadonlyArray<SearchHitDto> } | null>(null)
  const [refining, setRefining] = React.useState(false)
  React.useEffect(() => {
    setSimilar(null)
    if (data.type !== "search" || !search.q?.trim() || search.mode) return
    let cancelled = false
    setRefining(true)
    const shown = new Set(data.hits.map((h) => h.id))
    searchFn({ data: { q: data.query, mode: "hybrid", ...(search.kind ? { kinds: [search.kind] } : {}) } })
      .then((result) => {
        if (cancelled) return
        setSimilar({ query: data.query, hits: result.hits.filter((h) => !shown.has(h.id) && h.sources.some((s) => s !== "keyword")) })
      })
      .catch(() => undefined)
      .finally(() => !cancelled && setRefining(false))
    return () => {
      cancelled = true
    }
  }, [data, search.q, search.mode, search.kind])

  const cards = [...data.hits, ...(more?.hits ?? [])]
  const activeCategory = CATEGORIES.find((c) => c.id === search.cat)
  const building = live?.active.length ?? 0

  const setSearch = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => Object.fromEntries(Object.entries({ ...prev, ...patch }).filter(([, v]) => v !== undefined && v !== false)) })

  return (
    <div className="flex flex-col gap-7 pt-10">
      <section className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="flex max-w-[640px] flex-col gap-2.5">
          <h1 className="text-[34px] leading-[1.05] font-semibold tracking-[-0.045em] sm:text-[40px]">Every shadcn registry, running live.</h1>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Each component is installed with <span className="font-mono text-[13px] text-foreground">shadcn add</span>, built in a sandbox
            and captured. What you see is the real thing, not a screenshot from the docs.
          </p>
        </div>
        <div className="flex gap-8">
          <Stat value={data.totals.components.toLocaleString("en-US")} label="components" />
          <Stat value={data.totals.registries.toLocaleString("en-US")} label="registries" />
          <Link to="/live" className="rounded-md focus-visible:outline-2 focus-visible:outline-signal">
            <Stat
              value={live ? building : "–"}
              signal={building > 0}
              label={
                <>
                  <SignalDot pulse={building > 0} className="size-1.5" />
                  building now
                </>
              }
            />
          </Link>
        </div>
      </section>

      <section className="sticky top-15 z-20 -mx-4 flex flex-col gap-3 bg-background/95 px-4 pt-2 backdrop-blur sm:-mx-8 sm:px-8">
        <div className="flex gap-1 overflow-x-auto border-b [scrollbar-width:none]">
          {[{ id: undefined, label: "All" }, ...CATEGORIES].map((c) => {
            const selected = !search.q && search.cat === c.id
            return (
              <button
                key={c.label}
                type="button"
                onClick={() => setSearch({ cat: c.id, q: undefined })}
                className={cn(
                  "h-10 shrink-0 px-3 text-sm font-medium transition-colors",
                  selected ? "text-foreground shadow-[inset_0_-2px_0_var(--signal)]" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {c.label}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <form
            className="relative flex h-8 w-full items-center sm:w-72"
            onSubmit={(e) => {
              e.preventDefault()
              setSearch({ q: text.trim() || undefined, cat: undefined, mode: undefined })
            }}
          >
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Search — かっこいいボタン, glass card…"
              aria-label="Search components"
              className="h-8 w-full rounded-lg border bg-card pr-7 pl-8 text-[13px] outline-none placeholder:text-faint focus:border-ring"
            />
            {search.q && (
              <button type="button" aria-label="Clear search" className="absolute right-1.5 text-muted-foreground hover:text-foreground" onClick={() => setSearch({ q: undefined })}>
                <X className="size-3.5" />
              </button>
            )}
          </form>
          {data.type === "browse" && (
            <>
              <FacetButton pressed={!!search.motion} onClick={() => setSearch({ motion: !search.motion || undefined })}>
                <SignalDot /> Motion only
              </FacetButton>
              <FacetButton pressed={!!search.official} onClick={() => setSearch({ official: !search.official || undefined })}>
                <Check className="size-3.5" strokeWidth={2.5} /> Official only
              </FacetButton>
            </>
          )}
          <select
            value={search.kind ?? ""}
            onChange={(e) => setSearch({ kind: (e.target.value || undefined) as ComponentKind | undefined })}
            aria-label="Kind"
            className="h-8 rounded-lg border bg-card px-2.5 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground"
          >
            <option value="">Kind: any</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <span className="ml-auto font-mono text-xs text-faint">
            {data.type === "search"
              ? `${data.hits.length + (similar?.hits.length ?? 0)} results${activeCategory && !search.q ? ` · ${activeCategory.label.toLowerCase()}` : ""}`
              : `${cards.length}${next ? "+" : ""} shown · mixed across registries`}
          </span>
        </div>
      </section>

      {data.warnings.length > 0 && <p className="text-xs text-muted-foreground">Some search backends were unavailable: {data.warnings.join(" / ")}</p>}

      {cards.length === 0 ? (
        <div className="stage flex flex-col items-center gap-2 rounded-2xl border py-20 text-center">
          <p className="font-medium">{data.type === "search" ? "No exact matches." : "Nothing here yet."}</p>
          <p className="text-sm text-muted-foreground">
            {data.type === "search" ? (refining ? "Looking for similar components…" : "Try other words, or paste a screenshot with ⌘K.") : "Previews appear here as registries are built."}
          </p>
        </div>
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {cards.map((card, i) => (
            <React.Fragment key={card.id}>
              {data.sponsor && i === 5 && <SponsorCard sponsor={data.sponsor} />}
              <ComponentCard card={card as ComponentCardDto} {...(data.type === "search" && search.mode ? { sources: card.sources } : {})} />
            </React.Fragment>
          ))}
        </section>
      )}

      {data.type === "search" && !search.mode && (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between border-b pb-2">
            <h2 className="label-mono">Similar in meaning and look</h2>
            <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px]", refining ? "text-signal-foreground" : "text-faint")}>
              <span className={cn("size-1.5 rounded-full", refining ? "animate-signal bg-signal" : "bg-faint")} />
              {refining ? "refining…" : "semantic + visual"}
            </span>
          </div>
          {refining && !similar ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton aspect-[16/12] rounded-[14px]" />
              ))}
            </div>
          ) : similar && similar.hits.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {similar.hits.map((hit) => (
                <div key={hit.id} className="animate-rise">
                  <ComponentCard card={hit} sources={hit.sources.filter((s) => s !== "keyword")} />
                </div>
              ))}
            </div>
          ) : (
            !refining && <p className="text-sm text-muted-foreground">Nothing else close.</p>
          )}
        </section>
      )}

      {data.type === "browse" && next && (
        <div ref={sentinel} className="flex justify-center">
          <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore && <Loader2 className="animate-spin" />}
            Load more
          </Button>
        </div>
      )}

      <LiveTicker />
    </div>
  )
}

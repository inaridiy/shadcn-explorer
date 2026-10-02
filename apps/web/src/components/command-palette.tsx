import { useNavigate } from "@tanstack/react-router"
import { ImageUp, Loader2, Search } from "lucide-react"
import * as React from "react"
import type { SearchHitDto } from "~/server/dto"
import { searchByImageFn, searchFn } from "~/server/search"
import { cn } from "~/lib/utils"
import { ListingBadge } from "./listing-badge"

/**
 * ⌘K のパレット。キーワード (BM25) の一致をすぐに出し、意味・見た目で近いもの (埋め込み) は下の別枠に後から足す。
 * 先に出た並びは組み替えない (読んでいる途中で行が動かないように)
 */
const PaletteContext = React.createContext<{ open: () => void }>({ open: () => {} })
export const usePalette = () => React.useContext(PaletteContext)

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const value = React.useMemo(() => ({ open: () => setOpen(true) }), [])
  return (
    <PaletteContext.Provider value={value}>
      {children}
      {open && <CommandPalette onClose={() => setOpen(false)} />}
    </PaletteContext.Provider>
  )
}

type Row = { readonly hit: SearchHitDto; readonly group: "match" | "similar" | "image" }

const SOURCE_LABEL: Record<string, string> = { semantic: "meaning", "visual-text": "looks alike", "visual-image": "image" }

function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [query, setQuery] = React.useState("")
  const [matches, setMatches] = React.useState<ReadonlyArray<SearchHitDto>>([])
  const [similar, setSimilar] = React.useState<ReadonlyArray<SearchHitDto>>([])
  const [imageHits, setImageHits] = React.useState<ReadonlyArray<SearchHitDto> | null>(null)
  const [refining, setRefining] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const listId = React.useId()

  React.useEffect(() => inputRef.current?.focus(), [])

  React.useEffect(() => {
    const q = query.trim()
    setActive(0)
    if (q.length < 2) {
      setMatches([])
      setSimilar([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setLoading(true)
      setImageHits(null)
      try {
        const keyword = await searchFn({ data: { q, mode: "keyword", limit: 6 } })
        if (cancelled) return
        setMatches(keyword.hits)
        setSimilar([])
        setLoading(false)
        setRefining(true)
        const hybrid = await searchFn({ data: { q, mode: "hybrid", limit: 12 } })
        if (cancelled) return
        const shown = new Set(keyword.hits.map((h) => h.id))
        setSimilar(hybrid.hits.filter((h) => !shown.has(h.id) && h.sources.some((s) => s !== "keyword")).slice(0, 5))
      } catch {
        // 失敗しても一致は出ている
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefining(false)
        }
      }
    }, 140)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const runImage = async (file: File) => {
    setLoading(true)
    try {
      const form = new FormData()
      form.set("image", file)
      const result = await searchByImageFn({ data: form })
      setImageHits(result.hits.slice(0, 10))
      setActive(0)
    } finally {
      setLoading(false)
    }
  }

  const rows: ReadonlyArray<Row> = imageHits
    ? imageHits.map((hit) => ({ hit, group: "image" as const }))
    : [...matches.map((hit) => ({ hit, group: "match" as const })), ...similar.map((hit) => ({ hit, group: "similar" as const }))]

  const openRow = (row: Row | undefined) => {
    onClose()
    if (row) void navigate({ to: "/c/$registryId/$name", params: { registryId: row.hit.registryId, name: row.hit.name } })
    else if (query.trim()) void navigate({ to: "/", search: { q: query.trim() } })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose()
    else if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      openRow(e.metaKey || e.ctrlKey ? undefined : rows[active])
    }
  }

  const renderRow = (row: Row, index: number) => (
    <button
      key={`${row.group}-${row.hit.id}`}
      id={`${listId}-${index}`}
      type="button"
      role="option"
      aria-selected={index === active}
      onMouseEnter={() => setActive(index)}
      onClick={() => openRow(row)}
      className={cn(
        "flex w-full items-center gap-3.5 rounded-lg px-2.5 py-2 text-left",
        index === active && "bg-muted",
        row.group !== "match" && "animate-rise",
      )}
    >
      <span className="stage block h-[45px] w-[72px] shrink-0 overflow-hidden rounded-md border">
        {row.hit.screenshot && <img src={row.hit.screenshot.dark ?? row.hit.screenshot.light} alt="" className="size-full object-cover text-transparent" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{row.hit.title}</span>
        <span className="flex items-center gap-1.5 truncate font-mono text-[11.5px] text-muted-foreground">
          {row.hit.registryId} · {row.hit.kind}
          {row.hit.listing === "Community" && <ListingBadge listing="Community" className="h-4 text-[9px]" />}
        </span>
      </span>
      {row.group === "similar" && (
        <span className="rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          {SOURCE_LABEL[row.hit.sources.find((s) => s !== "keyword") ?? ""] ?? "related"}
        </span>
      )}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search components"
        className="w-full max-w-[720px] overflow-hidden rounded-2xl border bg-popover shadow-2xl shadow-black/40"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const file = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"))
          if (file) {
            e.preventDefault()
            void runImage(file)
          }
        }}
      >
        <div className="flex h-15 items-center gap-3 border-b px-4">
          {loading ? <Loader2 className="size-[18px] animate-spin text-muted-foreground" /> : <Search className="size-[18px] text-muted-foreground" />}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search components — or paste a screenshot"
            aria-label="Search components"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={rows.length > 0 ? `${listId}-${active}` : undefined}
            className="h-14 flex-1 bg-transparent text-[17px] outline-none placeholder:text-faint"
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void runImage(file)
              e.target.value = ""
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <ImageUp className="size-3.5" /> Image
          </button>
          <kbd className="rounded-[5px] border px-1.5 py-0.5 font-mono text-[11px] text-faint">esc</kbd>
        </div>

        <div id={listId} role="listbox" className="max-h-[60vh] overflow-y-auto p-2">
          {imageHits ? (
            <>
              <div className="label-mono px-2.5 pt-1.5 pb-1">Looks like your image</div>
              {rows.map(renderRow)}
            </>
          ) : query.trim().length < 2 ? (
            <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">
              Type what you want — “glass card”, “かっこいいボタン”, “pricing section” — or paste a screenshot.
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
                <span className="label-mono">Matches</span>
                <span className="font-mono text-[11px] text-faint">keyword</span>
              </div>
              {matches.length === 0 && !loading && <p className="px-2.5 py-2 text-sm text-muted-foreground">No exact matches.</p>}
              {matches.map((hit, i) => renderRow({ hit, group: "match" }, i))}
              <div className="flex items-center justify-between px-2.5 pt-3.5 pb-1">
                <span className="label-mono">Similar in meaning and look</span>
                <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px]", refining ? "text-signal-foreground" : "text-faint")}>
                  <span className={cn("size-1.5 rounded-full", refining ? "animate-signal bg-signal" : "bg-faint")} />
                  {refining ? "refining…" : "semantic + visual"}
                </span>
              </div>
              {refining && similar.length === 0 && (
                <div className="flex flex-col gap-2 px-2.5 py-1.5">
                  {[220, 180].map((w) => (
                    <div key={w} className="flex items-center gap-3.5">
                      <span className="skeleton h-[45px] w-[72px] rounded-md" />
                      <span className="skeleton h-3 rounded" style={{ width: w }} />
                    </div>
                  ))}
                </div>
              )}
              {similar.map((hit, i) => renderRow({ hit, group: "similar" }, matches.length + i))}
            </>
          )}
        </div>

        <div className="flex gap-4 border-t px-4 py-2.5 font-mono text-[11.5px] text-faint">
          <span>↵ open</span>
          <span>⌘↵ all results</span>
          <span className="ml-auto hidden sm:inline">paste an image to search by look</span>
        </div>
      </div>
    </div>
  )
}

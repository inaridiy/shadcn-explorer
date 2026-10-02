import { ExternalLink, Loader2, Monitor, Moon, Smartphone, Sun } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { Screenshot } from "~/components/component-card"
import { NEUTRAL_TOKENS, type ThemeTokensDto, isLightOnly } from "~/lib/theme"
import { cn } from "~/lib/utils"
import type { ComponentCardDto } from "~/server/dto"

const isDark = () => document.documentElement.classList.contains("dark")

export interface PreviewThemes {
  /** レジストリの既定のテーマ (スクショと同じ値)。無ければビルドのまま */
  readonly registry: ThemeTokensDto | null
  /** 同じレジストリが配る別のテーマ */
  readonly variants: ReadonlyArray<{ readonly name: string; readonly tokens: ThemeTokensDto }>
}

interface ThemeOption {
  readonly id: string
  readonly label: string
  /** null = ビルドしたままの値 (注入しない) */
  readonly tokens: ThemeTokensDto | null
  /** 色見本 (primary があれば primary、無ければ foreground) */
  readonly swatch: string | null
}

const storageKey = (registryId: string) => `preview-theme:${registryId}`
const readChoice = (registryId: string) => {
  try {
    return localStorage.getItem(storageKey(registryId))
  } catch {
    return null
  }
}
const saveChoice = (registryId: string, id: string) => {
  try {
    localStorage.setItem(storageKey(registryId), id)
  } catch {}
}

const swatchOf = (tokens: ThemeTokensDto | null) => tokens?.light["--primary"] ?? tokens?.light["--foreground"] ?? null

const toolButton = (active: boolean) =>
  cn(
    "grid size-8 place-items-center rounded-[7px] transition-colors focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-40 [&_svg]:size-[15px]",
    active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
  )

/**
 * プレビューの枠 (ui.shadcn.com の Preview / Code 相当)。上にツールバー、中にビルドしたデモの iframe かコード、下に由来の行。
 * - HTML は信頼しない: sandbox="allow-scripts" (allow-same-origin なし) + 配信側の CSP sandbox で不透明オリジンに閉じ込める
 * - 配色は既定でサイトに合わせ (初期値はクエリ、切り替えは postMessage)、ツールバーでこの枠だけ反転できる。
 *   ハーネスが高さを postMessage で知らせてくる
 * - テーマ (CSS 変数の値) は閲覧者が切り替えられる (preview:tokens)。既定はレジストリのテーマ (= スクショと同じ)。
 *   ダークを持たないテーマはライトに固定する。選択はレジストリごとにこのブラウザに覚える
 * - 幅はデスクトップ / スマホ (390px) を切り替えられる
 * - 読み込みが終わるまではスクショを表示する。ビルドが無ければスクショ (か作成中の表示) だけ
 */
export function LivePreview({
  src,
  card,
  layout,
  themes,
  tabs,
  codeView,
  footer,
}: {
  src: string | null
  card: ComponentCardDto
  layout: "centered" | "fullwidth"
  themes: PreviewThemes
  /** ツールバーの左 (Preview / Code の切り替え) */
  tabs: ReactNode
  /** Code タブの中身。null なら Preview を出す (iframe は裏で生かしておく) */
  codeView: ReactNode | null
  footer?: ReactNode
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const minHeight = layout === "fullwidth" ? 560 : 450
  const [height, setHeight] = useState(minHeight)
  const [loaded, setLoaded] = useState(false)
  // 初期の配色 (iframe の src に使う。以降の切り替えは postMessage なので再読み込みしない)
  const [initialScheme, setInitialScheme] = useState<"light" | "dark" | null>(null)
  // この枠の配色。サイトの配色が変わったらそれに戻る
  const [scheme, setScheme] = useState<"light" | "dark">("dark")
  const [width, setWidth] = useState<"desktop" | "phone">("desktop")

  const options = useMemo<ReadonlyArray<ThemeOption>>(
    () => [
      { id: "registry", label: themes.registry ? `@${card.registryId}` : "Default", tokens: themes.registry, swatch: swatchOf(themes.registry) },
      ...themes.variants.map((v, i) => ({ id: `variant:${i}`, label: v.name, tokens: v.tokens, swatch: swatchOf(v.tokens) })),
      { id: "neutral", label: "Neutral", tokens: NEUTRAL_TOKENS, swatch: "#71717a" },
    ],
    [themes, card.registryId],
  )
  // レジストリにテーマが無ければ切り替える意味がない
  const switchable = themes.registry !== null || themes.variants.length > 0
  const [choice, setChoice] = useState("registry")
  const selected = options.find((o) => o.id === choice) ?? options[0]!
  const lightOnly = isLightOnly(selected.tokens)
  const effective = lightOnly ? "light" : scheme

  useEffect(() => {
    const stored = readChoice(card.registryId)
    if (stored && options.some((o) => o.id === stored)) setChoice(stored)
  }, [card.registryId, options])

  // 選んだテーマと配色を iframe に送る (読み込み直後にも送る)
  const sync = useRef(() => {})
  sync.current = () => {
    const win = frame.current?.contentWindow
    if (!win) return
    win.postMessage({ type: "preview:tokens", tokens: selected.tokens }, "*")
    win.postMessage({ type: "preview:theme", theme: effective }, "*")
  }
  useEffect(() => sync.current(), [selected, effective])

  useEffect(() => {
    const site = isDark() ? "dark" : "light"
    setInitialScheme(site)
    setScheme(site)
    const observer = new MutationObserver(() => setScheme(isDark() ? "dark" : "light"))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const data = e.data as { type?: unknown; height?: unknown } | null
      if (data?.type === "preview:resize" && typeof data.height === "number") {
        setHeight(Math.min(Math.max(Math.ceil(data.height), minHeight), 1600))
      }
    }
    window.addEventListener("message", onMessage)
    return () => {
      observer.disconnect()
      window.removeEventListener("message", onMessage)
    }
  }, [minHeight])

  const showingCode = codeView !== null

  return (
    <section className="overflow-hidden rounded-[14px] border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b py-[7px] pr-2.5 pl-1.5">
        {tabs}
        <span className="grow" />
        {src && !showingCode && (
          <>
            {switchable && (
              <div className="order-last flex w-full max-w-full overflow-x-auto rounded-lg bg-muted p-0.5 sm:order-none sm:w-auto" role="radiogroup" aria-label="Preview theme">
                {options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={o.id === selected.id}
                    onClick={() => {
                      setChoice(o.id)
                      saveChoice(card.registryId, o.id)
                    }}
                    className={cn(
                      "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-signal",
                      o.id === selected.id ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {o.swatch && <span className="size-2 rounded-[3px] border border-black/10" style={{ background: o.swatch }} />}
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setScheme(scheme === "dark" ? "light" : "dark")}
              disabled={lightOnly}
              aria-label={lightOnly ? "This theme has no dark mode" : `Show the preview in ${scheme === "dark" ? "light" : "dark"} mode`}
              title={lightOnly ? "Light only" : "Toggle preview color mode"}
              className={cn(toolButton(false), "border")}
            >
              {effective === "dark" ? <Moon /> : <Sun />}
            </button>
            <div className="hidden gap-0.5 sm:flex">
              <button type="button" aria-label="Desktop width" aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")} className={toolButton(width === "desktop")}>
                <Monitor />
              </button>
              <button type="button" aria-label="Phone width" aria-pressed={width === "phone"} onClick={() => setWidth("phone")} className={toolButton(width === "phone")}>
                <Smartphone />
              </button>
            </div>
            <a
              href={`${src}?theme=${effective}`}
              target="_blank"
              rel="noreferrer"
              aria-label="Open preview in new tab"
              title="Open preview in new tab"
              className={toolButton(false)}
            >
              <ExternalLink />
            </a>
          </>
        )}
      </div>

      {codeView}
      <div className={cn(showingCode && "hidden")}>
        {src ? (
          <div className={cn("relative", width === "phone" ? "stage flex justify-center py-6" : effective === "dark" ? "bg-[#0a0a0a]" : "bg-white")}>
            {!loaded && (
              <div className="stage absolute inset-0 flex items-center justify-center">
                <Screenshot card={card} className="size-full opacity-60 [&_img]:object-contain" />
                <Loader2 className="absolute size-5 animate-spin text-muted-foreground" />
              </div>
            )}
            {/* 配色が決まってから読み込む (SSR 時点ではサイトの配色が分からない) */}
            {initialScheme && (
              <iframe
                ref={frame}
                title={`${card.title} live preview`}
                src={`${src}?theme=${initialScheme}`}
                sandbox="allow-scripts"
                loading="lazy"
                onLoad={() => {
                  setLoaded(true)
                  sync.current()
                }}
                style={{ height }}
                className={cn(
                  "block transition-[height,width] duration-200",
                  width === "phone" ? "w-[390px] max-w-full rounded-xl border shadow-lg shadow-black/10" : "w-full",
                )}
              />
            )}
            <span className="pointer-events-none absolute bottom-3 left-3 inline-flex h-[22px] items-center gap-1.5 rounded-md bg-zinc-950/70 px-2 font-mono text-[10.5px] text-zinc-300 backdrop-blur-sm">
              <span className="size-1.5 rounded-full bg-signal" />
              LIVE · running in a sandboxed iframe
            </span>
          </div>
        ) : (
          <Screenshot card={card} className="stage aspect-[16/10] w-full" />
        )}
      </div>
      {footer}
    </section>
  )
}

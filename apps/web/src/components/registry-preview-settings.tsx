import { useRouter } from "@tanstack/react-router"
import { Loader2, Settings2 } from "lucide-react"
import * as React from "react"
import { Button } from "~/components/ui/button"
import type { RegistryDto } from "~/server/dto"
import { updateRegistryPreviewConfigFn } from "~/server/registries"

/** "pkg@version" の行 → { pkg: version } (スコープ付きパッケージの先頭の @ は名前の一部) */
const parsePins = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((l) => {
        const at = l.lastIndexOf("@")
        return at > 0 ? [[l.slice(0, at), l.slice(at + 1)] as const] : []
      }),
  )

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)

const field = "w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"

const json = (value: unknown) => (value === undefined ? "" : JSON.stringify(value, null, 2))

/** 空なら undefined、JSON でなければ例外 (保存前にフォームへ出す) */
const parseJson = (label: string, text: string): unknown => {
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

/**
 * レジストリ単位のプレビュー設定 (運営者のみ)。コードの分岐ではなくデータで、レジストリ固有の事情を吸収する:
 * テーマ (トークン・Tailwind の名前・フォント・手書きの CSS)、全アイテムの前に入れるアイテム、依存のバージョン固定。
 * テーマは通常、検出・エージェントの提案を承認して入る。ここで手を入れるとテーマの状態は「手動」になる。
 * フォームに出していない項目 (css・variants) は保存しても残す。
 */
export function RegistryPreviewSettings({ registry }: { registry: RegistryDto }) {
  const router = useRouter()
  const config = registry.previewConfig
  const [themeCss, setThemeCss] = React.useState(config.themeCss ?? "")
  const [baseItems, setBaseItems] = React.useState((config.baseItems ?? []).join("\n"))
  const [pins, setPins] = React.useState(
    Object.entries(config.pins ?? {})
      .map(([p, v]) => `${p}@${v}`)
      .join("\n"),
  )
  const [tokens, setTokens] = React.useState(json(config.tokens))
  const [themeVars, setThemeVars] = React.useState(json(config.themeVars))
  const [fonts, setFonts] = React.useState((config.fonts ?? []).join("\n"))
  const [pending, setPending] = React.useState(false)
  const [message, setMessage] = React.useState<string | null>(null)

  return (
    <details className="rounded-xl border p-4">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
        <Settings2 className="size-4" /> Preview settings
      </summary>
      <form
        className="mt-4 flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setPending(true)
          setMessage(null)
          try {
            const res = await updateRegistryPreviewConfigFn({
              data: {
                registryId: registry.id,
                config: {
                  ...config,
                  themeCss,
                  baseItems: lines(baseItems),
                  pins: parsePins(pins),
                  tokens: parseJson("Tokens", tokens) as typeof config.tokens,
                  themeVars: parseJson("Theme variables", themeVars) as typeof config.themeVars,
                  fonts: lines(fonts),
                },
              },
            })
            setMessage(res.ok ? `Saved. Rebuilding ${res.rebuilding} previews.` : res.error.message)
            if (res.ok) await router.invalidate()
          } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err))
          } finally {
            setPending(false)
          }
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Theme tokens
          <span className="text-xs text-muted-foreground">
            CSS variable values, JSON <code className="font-mono">{'{ "light": { "--primary": "…" }, "dark": { … } }'}</code>. Omit dark
            for a light-only theme. Changing only values re-captures previews without rebuilding.
          </span>
          <textarea className={field} rows={6} value={tokens} onChange={(e) => setTokens(e.target.value)} placeholder='{ "light": { "--main": "#88aaee" } }' />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Theme variables (Tailwind)
          <span className="text-xs text-muted-foreground">
            Names components use as utilities, JSON <code className="font-mono">{'{ "--color-main": "var(--main)" }'}</code> (makes bg-main).
          </span>
          <textarea className={field} rows={3} value={themeVars} onChange={(e) => setThemeVars(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Fonts
          <span className="text-xs text-muted-foreground">Google Fonts family names, one per line (embedded at build time).</span>
          <textarea className={field} rows={2} value={fonts} onChange={(e) => setFonts(e.target.value)} placeholder="DM Sans" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Theme CSS (override)
          <span className="text-xs text-muted-foreground">
            Hand-written CSS applied after everything else, for what tokens cannot express.
          </span>
          <textarea className={field} rows={8} value={themeCss} onChange={(e) => setThemeCss(e.target.value)} placeholder=":root { --main: #88aaee; }" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Base items
          <span className="text-xs text-muted-foreground">Installed before every item, one per line (@namespace/name or URL).</span>
          <textarea className={field} rows={2} value={baseItems} onChange={(e) => setBaseItems(e.target.value)} placeholder="@acme/theme" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Pinned dependencies
          <span className="text-xs text-muted-foreground">One per line (package@version), for dependencies the registry leaves unpinned.</span>
          <textarea className={field} rows={2} value={pins} onChange={(e) => setPins(e.target.value)} placeholder="@tanstack/react-table@^8.21.3" />
        </label>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />} Save and rebuild previews
          </Button>
          {message && <span className="text-sm text-muted-foreground">{message}</span>}
        </div>
      </form>
    </details>
  )
}

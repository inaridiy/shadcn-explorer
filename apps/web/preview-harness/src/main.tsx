/**
 * Preview harness entry (trusted; the demo is not).
 * - #preview frame: "centered" mimics the ui.shadcn.com docs preview box, "fullwidth" is for blocks/pages.
 * - Theme: ?theme=dark or postMessage {type: "preview:theme", theme}.
 * - Theme tokens: postMessage {type: "preview:tokens", tokens: {light, dark?} | null} overrides the registry's theme values
 *   at runtime (the viewer switching between a registry's themes). Validated by theme-tokens.mjs; null restores the build.
 * - Tells the embedding page its height and signals readiness / render errors for the screenshotter.
 */
import { Component, type ReactNode, StrictMode, useLayoutEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { wrappers } from "./compat"
import Demo from "./demo"
import { tokensCss } from "../theme-tokens.mjs"
import config from "./preview.json"
import "./registry-fonts.css"
import "./index.css"

const root = document.documentElement
const setTheme = (theme: unknown) => {
  const dark = theme === "dark"
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
}
setTheme(new URLSearchParams(location.search).get("theme"))
const tokenStyle = document.createElement("style")
tokenStyle.id = "preview-tokens"
const setTokens = (tokens: unknown) => {
  tokenStyle.textContent = tokensCss(tokens ?? null)
  if (!tokenStyle.isConnected) document.head.appendChild(tokenStyle)
}
window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return
  if (e.data.type === "preview:theme") setTheme(e.data.theme)
  if (e.data.type === "preview:tokens") setTokens(e.data.tokens)
})

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error instanceof Error ? error.message : error) }
  }
  componentDidCatch(error: unknown) {
    root.dataset.previewError = String(error instanceof Error ? `${error.name}: ${error.message}` : error).slice(0, 1000)
  }
  render() {
    return this.state.error ? <pre className="p-4 text-sm text-destructive">{this.state.error}</pre> : this.props.children
  }
}

const CENTERED = "flex min-h-svh w-full items-center justify-center bg-background p-6 text-foreground sm:p-10"
const FULLWIDTH = "min-h-svh w-full bg-background text-foreground"

/**
 * The frame. Blocks/pages start full width; if the rendered block turns out to be a narrow widget (less than 60% of the
 * frame), it is centered like a component instead of sitting tiny in the top-left corner. The screenshotter reads
 * data-fit to pick its viewport.
 */
function Frame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<"centered" | "fullwidth">(config.layout === "fullwidth" ? "fullwidth" : "centered")
  useLayoutEffect(() => {
    const el = ref.current
    if (config.layout !== "fullwidth" || !el) return
    const widths = [...el.children].map((c) => c.getBoundingClientRect().width)
    const widest = Math.max(0, ...widths)
    if (widest > 0 && widest < el.clientWidth * 0.6) setFit("centered")
  }, [])
  return (
    <div id="preview" ref={ref} data-layout={config.layout} data-fit={fit} className={fit === "centered" ? CENTERED : FULLWIDTH}>
      {children}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Frame>
      <Boundary>{wrappers.reduceRight<ReactNode>((inner, Wrapper) => <Wrapper>{inner}</Wrapper>, <Demo />)}</Boundary>
    </Frame>
  </StrictMode>,
)

const preview = document.getElementById("root")!
new ResizeObserver(() => {
  window.parent.postMessage({ type: "preview:resize", height: Math.ceil(preview.scrollHeight) }, "*")
}).observe(preview)
requestAnimationFrame(() => requestAnimationFrame(() => (root.dataset.previewReady = "1")))

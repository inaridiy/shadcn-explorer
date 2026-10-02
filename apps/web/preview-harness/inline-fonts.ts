/**
 * Inlines remote web fonts (Google Fonts @import / @font-face url()) as data: URIs at build time,
 * so the preview stays self-contained and renders correctly under a CSP that forbids network access.
 */
import type { Plugin } from "vite"

const MAX_TOTAL_BYTES = 3_000_000
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
const IMPORT_RE = /@import\s+(?:url\()?\s*["']?(https:\/\/fonts\.googleapis\.com\/[^"')\s]+)["']?\s*\)?[^;]*;/g
const URL_RE = /url\(\s*["']?(https:\/\/[^"')\s]+\.(?:woff2?|ttf|otf)(?:\?[^"')\s]*)?)["']?\s*\)/g

const fetchText = async (url: string) => {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

const replaceAsync = async (text: string, re: RegExp, fn: (m: RegExpExecArray) => Promise<string>) => {
  const parts: Array<string | Promise<string>> = []
  let last = 0
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), fn(m as RegExpExecArray))
    last = m.index! + m[0].length
  }
  parts.push(text.slice(last))
  return (await Promise.all(parts)).join("")
}

export const inlineFonts = (): Plugin => {
  let total = 0
  const inlineUrls = (css: string) =>
    replaceAsync(css, URL_RE, async (m) => {
      try {
        const res = await fetch(m[1], { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return m[0]
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (total + bytes.length > MAX_TOTAL_BYTES) return m[0]
        total += bytes.length
        const type = m[1].includes(".woff2") ? "font/woff2" : m[1].includes(".woff") ? "font/woff" : "font/ttf"
        return `url(data:${type};base64,${Buffer.from(bytes).toString("base64")})`
      } catch {
        return m[0]
      }
    })
  return {
    name: "inline-remote-fonts",
    enforce: "pre",
    async transform(code, id) {
      if (!/\.css(\?|$)/.test(id) || !/https:\/\//.test(code)) return null
      const withImports = await replaceAsync(code, IMPORT_RE, async (m) => {
        try {
          // Keep only the latin subsets: they cover demo text and keep the HTML small
          const css = await fetchText(m[1])
          const faces = css.split(/(?=\/\*[^*]*\*\/\s*@font-face)/).filter((f) => !/\/\*\s*(cyrillic|greek|vietnamese)/.test(f))
          return faces.join("\n")
        } catch {
          return ""
        }
      })
      return { code: await inlineUrls(withImports), map: null }
    },
  }
}

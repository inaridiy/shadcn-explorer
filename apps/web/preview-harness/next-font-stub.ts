/**
 * Rewrites any named import from next/font/google|local into the default font stub, so every font name works
 * without listing them (`import { Inter, Pacifico as P } from "next/font/google"` → `const Inter = __nextFont, P = __nextFont`).
 */
import path from "node:path"
import type { Plugin } from "vite"

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*["']next\/font\/(?:google|local)["'];?/g

export const nextFontStub = (stubFile: string): Plugin => ({
  name: "next-font-stub",
  enforce: "pre",
  transform(code, id) {
    if (!/\.[jt]sx?$/.test(id) || !code.includes("next/font/")) return null
    let used = false
    const out = code.replace(IMPORT_RE, (_m, names: string) => {
      used = true
      const locals = names
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
        .map((n) => (n.includes(" as ") ? n.split(/\s+as\s+/)[1]!.trim() : n))
      return locals.length > 0 ? `const ${locals.map((l) => `${l} = __nextFont`).join(", ")};` : ""
    })
    if (!used) return null
    return { code: `import __nextFont from ${JSON.stringify(path.resolve(stubFile))};\n${out}`, map: null }
  },
})

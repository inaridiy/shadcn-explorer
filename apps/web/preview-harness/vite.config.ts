import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"
import { readFileSync } from "node:fs"
import { inlineFonts } from "./inline-fonts.ts"
import { nextFontStub } from "./next-font-stub.ts"

const src = path.resolve(import.meta.dirname, "src")
const stub = (name: string) => path.join(src, "next-stubs", name)
// Build-manifest aliases (`alias` actions): module specifier → file under src/compat
const compatAliases = Object.entries(JSON.parse(readFileSync(path.join(src, "compat/aliases.json"), "utf8")) as Record<string, string>)

export default defineConfig({
  plugins: [nextFontStub(stub("font.ts")), inlineFonts(), react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: [
      ...compatAliases.map(([find, file]) => ({ find: new RegExp(`^${find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), replacement: path.join(src, "compat", file) })),
      { find: /^next\/link$/, replacement: stub("link.tsx") },
      { find: /^next\/image$/, replacement: stub("image.tsx") },
      { find: /^next\/navigation$/, replacement: stub("navigation.ts") },
      { find: /^next\/router$/, replacement: stub("navigation.ts") },
      { find: /^next\/font\/(google|local)$/, replacement: stub("font.ts") }, // default imports; named ones: nextFontStub
      { find: /^next\/dynamic$/, replacement: stub("dynamic.tsx") },
      { find: /^next\/script$/, replacement: stub("script.tsx") },
      { find: /^next\/head$/, replacement: stub("head.tsx") },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  // Registry code sometimes reads process.env.NODE_ENV (Next.js habit)
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  logLevel: "warn",
  build: { chunkSizeWarningLimit: 10_000, reportCompressedSize: false },
})

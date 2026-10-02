/**
 * 生成ドキュメントの機械的な正しさ検査 (両モデル)。
 * - props がソースに実在するか (識別子としての出現)
 * - usage / examples の import がアイテムの実在するパスと export 名を使っているか
 * - 日本語キーワードの数
 * 結果は out/doc-report.json と標準出力の表。
 */
import path from "node:path"
import { itemImportPaths } from "@shadcn-explorer/core/domain"
import { MODELS, OUT, fileId, itemOf, listJson, readJson, sample, writeJson } from "./lib"

const stripExt = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|css)$/, "")

const sourceOf = (item: any): { text: string; exports: Set<string>; hasDefault: boolean; deps: Set<string>; regDeps: Set<string> } => {
  const files: Array<{ path: string; content?: string }> = item.files ?? []
  const text = files.map((f) => f.content ?? "").join("\n")
  const exports = new Set<string>()
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) exports.add(m[1]!)
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) exports.add(name)
    }
  }
  const hasDefault = /export\s+default\b/.test(text)
  const deps = new Set<string>((item.dependencies ?? []).map((d: string) => d.replace(/@[\^~\d][^/]*$/, "")))
  const regDeps = new Set<string>((item.registryDependencies ?? []).map((d: string) => d.split("/").pop()!.replace(/\.json$/, "")))
  return { text, exports, hasDefault, deps, regDeps }
}

const PREINSTALLED = new Set(["button", "card", "input", "label", "badge", "separator", "avatar", "switch", "checkbox", "textarea", "tabs"])
const COMMON_PKGS = new Set(["react", "react-dom", "lucide-react", "next", "next/link", "next/image", "next/navigation", "class-variance-authority", "clsx", "tailwind-merge"])

interface ImportCheck {
  readonly code: string
  readonly path: string
  readonly names: ReadonlyArray<string>
  readonly verdict: "item-ok" | "item-missing-export" | "item-missing-default" | "dep-ok" | "local-unknown" | "pkg-ok" | "pkg-unknown"
  readonly missing?: ReadonlyArray<string>
}

const checkImports = (code: string, item: any, src: ReturnType<typeof sourceOf>): Array<ImportCheck> => {
  const itemPaths = new Set(itemImportPaths(item).map(stripExt))
  const out: Array<ImportCheck> = []
  for (const m of code.matchAll(/import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+\w+)?\s*(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)) {
    const def = m[1]
    const names = (m[2] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean)
    const p = stripExt(m[3]!)
    if (itemPaths.has(p)) {
      const missing = names.filter((n) => !src.exports.has(n))
      if (def && !src.hasDefault) out.push({ code: m[0], path: p, names, verdict: "item-missing-default" })
      else if (missing.length) out.push({ code: m[0], path: p, names, verdict: "item-missing-export", missing })
      else out.push({ code: m[0], path: p, names, verdict: "item-ok" })
    } else if (p.startsWith("@/") || p.startsWith("./") || p.startsWith("~/")) {
      const base = p.split("/").pop()!
      const ok = src.regDeps.has(base) || PREINSTALLED.has(base) || p === "@/lib/utils" || src.text.includes(p) || src.text.includes(base)
      out.push({ code: m[0], path: p, names, verdict: ok ? "dep-ok" : "local-unknown" })
    } else {
      const pkg = p.startsWith("@") ? p.split("/").slice(0, 2).join("/") : p.split("/")[0]!
      const ok = src.deps.has(pkg) || COMMON_PKGS.has(pkg) || src.text.includes(`from "${p}"`) || src.text.includes(`from '${p}'`)
      out.push({ code: m[0], path: p, names, verdict: ok ? "pkg-ok" : "pkg-unknown" })
    }
  }
  return out
}

const JA = /[぀-ヿ一-鿿]/

const report: Record<string, any> = {}
for (const model of MODELS) {
  const dir = path.join(OUT, "doc", model)
  const rows: Array<any> = []
  for (const entry of sample()) {
    const file = path.join(dir, `${fileId(entry.id)}.json`)
    if (!listJson(dir).includes(`${fileId(entry.id)}.json`)) continue
    const rec = readJson(file)
    const item = itemOf(entry.id)
    const src = sourceOf(item)
    if (!rec.ok) {
      rows.push({ id: entry.id, ok: false, error: rec.error })
      continue
    }
    const doc = rec.doc
    const propChecks = (doc.props as Array<{ name: string }>).map((p) => ({
      name: p.name,
      found: new RegExp(`\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(src.text),
    }))
    const codes = [doc.usage, ...doc.examples.map((e: any) => e.code)]
    const imports = codes.flatMap((c) => checkImports(c, item, src))
    const itemImported = imports.some((i) => i.verdict.startsWith("item-"))
    const ja = (doc.keywords as Array<string>).filter((k) => JA.test(k))
    const u = rec.raw.at(-1)?.usage
    rows.push({
      id: entry.id,
      kind: entry.kind,
      ok: true,
      wallMs: rec.wallMs,
      input: u?.input_tokens,
      cached: u?.input_tokens_details?.cached_tokens ?? 0,
      output: u?.output_tokens,
      reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0,
      props: propChecks.length,
      propsMissing: propChecks.filter((p) => !p.found).map((p) => p.name),
      examples: doc.examples.length,
      imports: imports.length,
      importProblems: imports.filter((i) => ["item-missing-export", "item-missing-default", "local-unknown", "pkg-unknown"].includes(i.verdict)),
      itemImported: itemImported || itemImportPaths(item).length === 0,
      keywords: doc.keywords.length,
      keywordsJa: ja.length,
      fences: codes.some((c) => c.includes("```")),
      summaryLen: doc.summary.length,
      usageLines: doc.usage.split("\n").length,
    })
  }
  const okRows = rows.filter((r) => r.ok)
  const sum = (k: string) => okRows.reduce((a, r) => a + (r[k] ?? 0), 0)
  const avg = (k: string) => (okRows.length ? sum(k) / okRows.length : 0)
  const summary = {
    n: rows.length,
    ok: okRows.length,
    avgWallMs: Math.round(avg("wallMs")),
    avgInput: Math.round(avg("input")),
    avgCached: Math.round(avg("cached")),
    avgOutput: Math.round(avg("output")),
    avgReasoning: Math.round(avg("reasoning")),
    props: sum("props"),
    propsMissing: okRows.reduce((a, r) => a + r.propsMissing.length, 0),
    itemsWithMissingProps: okRows.filter((r) => r.propsMissing.length > 0).length,
    imports: sum("imports"),
    importProblems: okRows.reduce((a, r) => a + r.importProblems.length, 0),
    itemsWithImportProblems: okRows.filter((r) => r.importProblems.length > 0).length,
    itemsNotImportingItem: okRows.filter((r) => !r.itemImported).length,
    avgKeywords: avg("keywords").toFixed(1),
    avgKeywordsJa: avg("keywordsJa").toFixed(1),
    itemsNoJa: okRows.filter((r) => r.keywordsJa === 0).length,
    fences: okRows.filter((r) => r.fences).length,
  }
  report[model] = { summary, rows }
  console.log(`\n== ${model}`)
  console.table(summary)
  for (const r of rows) {
    if (!r.ok) console.log(`  FAIL ${r.id}: ${JSON.stringify(r.error).slice(0, 160)}`)
    else if (r.propsMissing.length || r.importProblems.length || !r.itemImported)
      console.log(
        `  ${r.id}: propsMissing=${JSON.stringify(r.propsMissing)} importProblems=${r.importProblems.map((i: any) => `${i.verdict}:${i.path}${i.missing ? `[${i.missing}]` : ""}`).join(", ")}${r.itemImported ? "" : " NOT-IMPORTING-ITEM"}`,
      )
  }
}
writeJson(path.join(OUT, "doc-report.json"), report)

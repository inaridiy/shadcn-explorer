/**
 * 検索品質のオフライン評価。
 *   pnpm --filter @shadcn-explorer/core eval:search -- --base http://localhost:3000 [--k 10] [--cookie "..."] [--key sce_...]
 * 各モード (keyword / semantic / visual / hybrid) で golden.json を検索し、recall@k と MRR をタグ別に出す。
 */
import { readFileSync } from "node:fs"
import { type ComponentId, type GoldenQuery, summarizeEvaluation } from "../src/domain/index.js"

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "")
const base = args.get("base") ?? "http://localhost:3000"
const k = Number(args.get("k") ?? 10)
const headers: Record<string, string> = {}
if (args.get("key")) headers["x-api-key"] = args.get("key")!
if (args.get("cookie")) headers.cookie = args.get("cookie")!

const golden = JSON.parse(readFileSync(new URL("../eval/golden.json", import.meta.url), "utf8")) as {
  queries: Array<GoldenQuery>
}
const modes = ["keyword", "semantic", "visual", "hybrid"] as const

const search = async (q: string, mode: string): Promise<Array<ComponentId>> => {
  const url = `${base}/api/v1/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=${Math.max(k, 20)}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const body = (await res.json()) as { hits: Array<{ id: ComponentId }>; warnings: Array<string> }
  if (body.warnings.length > 0) console.warn(`  [${mode}] ${q}: ${body.warnings.join("; ")}`)
  return body.hits.map((h) => h.id)
}

const tags = [...new Set(golden.queries.flatMap((q) => q.tags ?? []))]
const rows: Array<Record<string, string>> = []
for (const mode of modes) {
  const results = []
  for (const g of golden.queries) results.push({ golden: g, ranked: await search(g.query, mode) })
  const all = summarizeEvaluation(results, k)
  const row: Record<string, string> = { mode, [`R@${k}`]: all.meanRecallAtK.toFixed(3), MRR: all.mrr.toFixed(3) }
  for (const tag of tags) {
    const subset = results.filter((r) => r.golden.tags?.includes(tag))
    row[`MRR:${tag}`] = summarizeEvaluation(subset, k).mrr.toFixed(3)
  }
  rows.push(row)
  const misses = all.perQuery.filter((q) => q.firstRelevantRank === null).map((q) => q.query)
  if (misses.length > 0) console.log(`[${mode}] no relevant hit: ${misses.join(" / ")}`)
}
console.table(rows)

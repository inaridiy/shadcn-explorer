/**
 * モデル比較 eval の共通部品 (gpt-6-luna vs gpt-5.6-luna)。
 * 本番の adapter (openai-doc-writer / openai-demo-writer) をそのまま使い、fetch を包んで usage (reasoning tokens 込み) を記録する。
 * 実行: cd apps/web && ../../packages/core/node_modules/.bin/vite-node --config ../../evals/models/vite.config.ts --root ../../evals/models <script> <model>
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { RegistryId, WireRegistryItem, toComponentSnapshot, installCommand, demoLayoutOf } from "@shadcn-explorer/core/domain"
import type { ComponentSnapshot } from "@shadcn-explorer/core/domain"

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname))
export const OUT = path.join(ROOT, process.env.OUT_DIR ?? "out")

export const MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const
export type Model = (typeof MODELS)[number]

export const apiKey = (): string => {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  // apps/web/.dev.vars が無いので、同じ組織の sibling project (my-agents) の .dev.vars から読む
  for (const f of [path.resolve(ROOT, "../../apps/web/.dev.vars"), path.join(process.env.HOME ?? "", "my-agents/.dev.vars")]) {
    if (!existsSync(f)) continue
    const m = readFileSync(f, "utf8").match(/^OPENAI_API_KEY\s*=\s*"?([^"\n]+)"?/m)
    if (m) return m[1]!.trim()
  }
  throw new Error("OPENAI_API_KEY not found")
}

export interface SampleEntry {
  readonly id: string
  readonly kind: string
  readonly sourceUrl: string
}
export const sample = (): ReadonlyArray<SampleEntry> => JSON.parse(readFileSync(path.join(ROOT, process.env.SAMPLE ?? "sample.json"), "utf8"))
export const registries = (): Record<string, { namespace: string | null; locator: { indexUrl: string; itemUrlTemplate: string }; previewConfig: Record<string, unknown> }> =>
  JSON.parse(readFileSync(path.join(ROOT, "registries.json"), "utf8"))

export const itemOf = (id: string): unknown => JSON.parse(readFileSync(path.join(ROOT, "items", `${id.replace(":", "__")}.json`), "utf8"))

export interface Prepared {
  readonly entry: SampleEntry
  readonly registryId: string
  readonly namespace: string | null
  readonly itemJson: unknown
  readonly snapshot: ComponentSnapshot
  readonly installCommand: string
  readonly layout: "centered" | "fullwidth"
}

export const prepare = async (entry: SampleEntry): Promise<Prepared> => {
  const registryId = entry.id.split(":")[0]!
  const itemJson = itemOf(entry.id)
  const wire = Schema.decodeUnknownSync(WireRegistryItem)(itemJson)
  const snapshot = await Effect.runPromise(toComponentSnapshot(RegistryId.make(registryId), wire, entry.sourceUrl))
  const namespace = registries()[registryId]?.namespace ?? null
  return { entry, registryId, namespace, itemJson, snapshot, installCommand: installCommand(snapshot, namespace), layout: demoLayoutOf(snapshot.kind) }
}

/** fetch を包んで Responses API の生の usage / status を記録する (adapter は変更しない) */
export interface RawCall {
  readonly componentId: string
  readonly purpose: string
  readonly model: string
  readonly status: number
  readonly responseStatus?: string
  readonly incomplete?: unknown
  readonly error?: unknown
  readonly usage?: {
    input_tokens: number
    output_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
    total_tokens?: number
  }
  readonly durationMs: number
  readonly requestBytes: number
}
export const calls: Array<RawCall> = []

export const installFetchRecorder = () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.endsWith("/responses")) return original(input, init)
    const started = Date.now()
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; metadata?: Record<string, string> }
    const res = await original(input, init)
    const text = await res.text()
    let json: any = null
    try {
      json = JSON.parse(text)
    } catch {}
    calls.push({
      componentId: body.metadata?.component_id ?? "?",
      purpose: body.metadata?.purpose ?? "doc",
      model: body.model,
      status: res.status,
      responseStatus: json?.status,
      incomplete: json?.incomplete_details,
      error: json?.error,
      usage: json?.usage,
      durationMs: Date.now() - started,
      requestBytes: String(init?.body ?? "").length,
    })
    return new Response(text, { status: res.status, headers: res.headers })
  }) as typeof fetch
}

export const outDir = (...parts: Array<string>) => {
  const dir = path.join(OUT, ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}
export const writeJson = (file: string, data: unknown) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
export const readJson = <T = any>(file: string): T => JSON.parse(readFileSync(file, "utf8"))
export const listJson = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [])
export const fileId = (id: string) => id.replace(":", "__")

export const mapLimit = async <A, B>(items: ReadonlyArray<A>, limit: number, f: (a: A) => Promise<B>): Promise<Array<B>> => {
  const results: Array<B> = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await f(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

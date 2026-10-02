/**
 * `examples` が空で返る問題の検証 (eval 専用。src は変更しない)。
 * openai-doc-writer.ts の usageDocJsonSchema をコピーし、examples に minItems: 1 / maxItems: 4 を足して
 * strict Structured Outputs が受け付けるか (400 にならないか) と、空 examples の割合を両モデルで実測する。
 *   usage: examples-schema.ts <model> <id,id,...>
 */
import path from "node:path"
import { Schema } from "effect"
import { UsageDoc } from "@shadcn-explorer/core/domain"
import { buildDocPrompt, outputText, ResponsesOutput } from "../../apps/web/src/infrastructure/openai-doc-writer"
import { apiKey, fileId, outDir, prepare, sample, writeJson } from "./lib"

const model = process.argv[2]!
const ids = (process.argv[3] ?? "").split(",").filter(Boolean)

// --- コピー元: apps/web/src/infrastructure/openai-doc-writer.ts (examples の minItems/maxItems だけ追加) ---
const str = { type: "string" } as const
const strArray = { type: "array", items: str } as const
const usageDocJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "visualDescription", "whenToUse", "usage", "examples", "props", "accessibility", "keywords"],
  properties: {
    summary: str,
    visualDescription: str,
    whenToUse: strArray,
    usage: str,
    examples: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "code"],
        properties: { title: str, description: str, code: str },
      },
    },
    props: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "type", "default", "description"],
        properties: { name: str, type: str, default: { type: ["string", "null"] }, description: str },
      },
    },
    accessibility: strArray,
    keywords: strArray,
  },
} as const
const INSTRUCTIONS = `You are a senior design-engineer who documents shadcn/ui registry items.
Read the registry item's real source code and describe its actual API precisely. Never invent props that are not in the source.
All text in English except the Japanese keywords requested below. Code samples are TSX that would type-check against the source.`
// --- ここまでコピー ---

const dir = outDir("examples-schema", model)
const results: Array<any> = []
for (const entry of sample().filter((e) => ids.includes(e.id))) {
  const p = await prepare(entry)
  const started = Date.now()
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey()}` },
    body: JSON.stringify({
      model,
      instructions: INSTRUCTIONS,
      input: buildDocPrompt({ snapshot: p.snapshot, itemJson: p.itemJson, installCommand: p.installCommand }),
      text: { format: { type: "json_schema", name: "usage_doc", strict: true, schema: usageDocJsonSchema } },
      metadata: { component_id: entry.id, purpose: "examples-schema" },
    }),
  })
  const text = await res.text()
  let row: any = { id: entry.id, model, http: res.status, ms: Date.now() - started }
  if (!res.ok) row.error = text.slice(0, 600)
  else {
    const json = JSON.parse(text)
    const decoded = Schema.decodeUnknownEither(ResponsesOutput)(json)
    const doc = decoded._tag === "Right" ? JSON.parse(outputText(decoded.right)) : null
    const valid = doc ? Schema.decodeUnknownEither(UsageDoc)({ ...doc, props: doc.props.map(({ default: d, ...r }: any) => (d == null ? r : { ...r, default: d })) })._tag === "Right" : false
    row = { ...row, examples: doc?.examples?.length ?? null, valid, usage: json.usage, status: json.status }
    writeJson(path.join(dir, `${fileId(entry.id)}.json`), { row, doc })
  }
  results.push(row)
  console.log(JSON.stringify(row).slice(0, 300))
}
writeJson(path.join(dir, "_summary.json"), results)

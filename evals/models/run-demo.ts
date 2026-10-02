/** DemoWriter を本番 adapter のまま実行し、lintDemo を掛けて out/demo/<model>/<id>.json に保存する。hook/lib は本番同様に対象外。 */
import path from "node:path"
import { existsSync } from "node:fs"
import { Effect, Option } from "effect"
import { UsageDoc, itemImportPaths, lintDemo } from "@shadcn-explorer/core/domain"
import { DemoWriter } from "@shadcn-explorer/core/ports"
import { OpenAIDemoWriter } from "../../apps/web/src/infrastructure/openai-demo-writer"
import { OUT, apiKey, calls, fileId, installFetchRecorder, mapLimit, outDir, prepare, readJson, sample, writeJson } from "./lib"

const model = process.argv[2]
if (!model) throw new Error("usage: run-demo.ts <model> [limit]")
const limit = Number(process.argv[3] ?? 0) || undefined

installFetchRecorder()
const layer = OpenAIDemoWriter({ apiKey: apiKey(), model })
const dir = outDir("demo", model)

const entries = (limit ? sample().slice(0, limit) : sample()).filter((e) => !["hook", "lib", "file"].includes(e.kind))
await mapLimit(entries, 6, async (entry) => {
  const p = await prepare(entry)
  // 本番と同じく、同じモデルが書いたドキュメントの usage を API ノートとして渡す
  const docFile = path.join(OUT, "doc", model, `${fileId(entry.id)}.json`)
  const docRecord = existsSync(docFile) ? readJson(docFile) : null
  const doc = docRecord?.doc ? Option.some(new UsageDoc(docRecord.doc)) : Option.none<UsageDoc>()
  const started = Date.now()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* DemoWriter
      return yield* writer.write({ snapshot: p.snapshot, itemJson: p.itemJson, installCommand: p.installCommand, doc, layout: p.layout })
    }).pipe(Effect.provide(layer), Effect.either),
  )
  const raw = calls.filter((c) => c.componentId === entry.id && c.purpose === "demo")
  const code = result._tag === "Right" ? result.right.code : null
  const lint = code ? lintDemo(code, itemImportPaths(p.itemJson)) : []
  const record = {
    id: entry.id,
    kind: entry.kind,
    model,
    ok: result._tag === "Right",
    error: result._tag === "Left" ? { tag: result.left._tag, reason: String((result.left as any).reason ?? result.left) } : null,
    code,
    lint,
    usage: result._tag === "Right" ? result.right.usage : null,
    raw,
    wallMs: Date.now() - started,
  }
  writeJson(path.join(dir, `${fileId(entry.id)}.json`), record)
  const u = raw.at(-1)?.usage
  console.log(
    `${record.ok ? (lint.length === 0 ? "ok  " : "LINT") : "FAIL"} ${model} ${entry.id} ${record.wallMs}ms in=${u?.input_tokens} cached=${u?.input_tokens_details?.cached_tokens ?? 0} out=${u?.output_tokens} reasoning=${u?.output_tokens_details?.reasoning_tokens ?? 0} lines=${code?.split("\n").length ?? 0}${lint.length ? ` ${lint.join(" | ").slice(0, 160)}` : ""}${record.error ? ` ${record.error.reason.slice(0, 120)}` : ""}`,
  )
})

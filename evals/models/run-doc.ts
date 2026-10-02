/** DocWriter を本番 adapter のまま 24 件に対して実行し、out/doc/<model>/<id>.json に保存する。 */
import path from "node:path"
import { Effect, Option } from "effect"
import { DocWriter } from "@shadcn-explorer/core/ports"
import { OpenAIDocWriter } from "../../apps/web/src/infrastructure/openai-doc-writer"
import { apiKey, calls, fileId, installFetchRecorder, mapLimit, outDir, prepare, sample, writeJson } from "./lib"

const model = process.argv[2]
if (!model) throw new Error("usage: run-doc.ts <model> [limit]")
const limit = Number(process.argv[3] ?? 0) || undefined

installFetchRecorder()
const layer = OpenAIDocWriter({ apiKey: apiKey(), model })
const dir = outDir("doc", model)

const entries = limit ? sample().slice(0, limit) : sample()
await mapLimit(entries, 6, async (entry) => {
  const p = await prepare(entry)
  const started = Date.now()
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* DocWriter
      return yield* writer.write({ snapshot: p.snapshot, itemJson: p.itemJson, installCommand: p.installCommand })
    }).pipe(Effect.provide(layer), Effect.either),
  )
  const raw = calls.filter((c) => c.componentId === entry.id && c.purpose === "doc")
  const record = {
    id: entry.id,
    kind: entry.kind,
    model,
    ok: result._tag === "Right",
    error: result._tag === "Left" ? { tag: result.left._tag, reason: String((result.left as any).reason ?? result.left) } : null,
    doc: result._tag === "Right" ? result.right.doc : null,
    usage: result._tag === "Right" ? result.right.usage : null,
    raw,
    wallMs: Date.now() - started,
  }
  writeJson(path.join(dir, `${fileId(entry.id)}.json`), record)
  const u = raw.at(-1)?.usage
  console.log(
    `${record.ok ? "ok  " : "FAIL"} ${model} ${entry.id} ${record.wallMs}ms in=${u?.input_tokens} cached=${u?.input_tokens_details?.cached_tokens ?? 0} out=${u?.output_tokens} reasoning=${u?.output_tokens_details?.reasoning_tokens ?? 0}${record.error ? ` ${record.error.reason.slice(0, 120)}` : ""}`,
  )
  void Option
})

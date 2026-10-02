/**
 * 生成デモをローカルの preview-harness イメージ (docker) でビルドし、本番と同じ修正ループ (lint / build / tsc → repair 最大 2 回) を回す。
 * out/build/<model>/<id>/attempt-N.{tsx,json} と out/build-report.json に残す。
 *   usage: build.ts <model> [idFilter]
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Effect, Option } from "effect"
import { UsageDoc, itemImportPaths, lintDemo } from "@shadcn-explorer/core/domain"
import { DemoWriter } from "@shadcn-explorer/core/ports"
import { OpenAIDemoWriter } from "../../apps/web/src/infrastructure/openai-demo-writer"
import { OUT, apiKey, calls, fileId, installFetchRecorder, outDir, prepare, readJson, registries, sample, writeJson } from "./lib"

const model = process.argv[2]
if (!model) throw new Error("usage: build.ts <model> [idFilter]")
const filter = process.argv[3]
const IMAGE = process.env.HARNESS_IMAGE ?? "cloudflare-dev/harnessdo-harness-2a498647b4b2:8936db32"
const MAX_REPAIRS = 2
/** 修正だけ別モデルで回す腕 (計画中のルーティング: demo=5.6 / repair=6-luna) */
const repairModel = process.env.REPAIR_MODEL ?? model
const arm = repairModel === model ? model : `${model}+repair-${repairModel}`

installFetchRecorder()
const layer = OpenAIDemoWriter({ apiKey: apiKey(), model: repairModel })
const regs = registries()
const registriesMap = Object.fromEntries(
  Object.values(regs)
    .filter((r) => r.namespace)
    .map((r) => [r.namespace!, r.locator.itemUrlTemplate]),
)

interface JobResult {
  ok: boolean
  stage?: string
  cause?: string
  errors?: Array<string>
  diagnostics?: Array<string>
  workarounds?: Array<string>
  seconds: number
  raw?: string
}

const runJob = (dir: string, job: unknown): JobResult => {
  writeFileSync(path.join(dir, "job.json"), JSON.stringify(job))
  const started = Date.now()
  const r = spawnSync(
    "docker",
    ["run", "--rm", "--entrypoint", "node", "-v", `${dir}:/job`, IMAGE, "/opt/harness/run-job.mjs", "/job/job.json", "/job/out.html"],
    { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  )
  const seconds = (Date.now() - started) / 1000
  writeFileSync(path.join(dir, "stdout.txt"), r.stdout ?? "")
  writeFileSync(path.join(dir, "stderr.txt"), r.stderr ?? "")
  const line = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).at(-1)
  if (!line) return { ok: false, stage: "harness", cause: "harness", errors: [`no result line (exit ${r.status}): ${(r.stderr ?? "").slice(-500)}`], seconds }
  try {
    return { ...JSON.parse(line), seconds }
  } catch {
    return { ok: false, stage: "harness", cause: "harness", errors: [`bad result line: ${line.slice(0, 300)}`], seconds }
  }
}

const reportFile = path.join(OUT, `build-report.${arm}.json`)
const report: Record<string, any> = existsSync(reportFile) ? readJson(reportFile) : {}

for (const entry of sample()) {
  if (["hook", "lib", "file"].includes(entry.kind)) continue
  if (filter && !entry.id.includes(filter)) continue
  if (report[entry.id]?.final) continue
  const demoFile = path.join(OUT, "demo", model, `${fileId(entry.id)}.json`)
  if (!existsSync(demoFile)) continue
  const demoRec = readJson(demoFile)
  if (!demoRec.ok) {
    report[entry.id] = { final: "no-demo", attempts: [] }
    continue
  }
  const p = await prepare(entry)
  const docFile = path.join(OUT, "doc", model, `${fileId(entry.id)}.json`)
  const docRec = existsSync(docFile) ? readJson(docFile) : null
  const doc = docRec?.doc ? Option.some(new UsageDoc(docRec.doc)) : Option.none<UsageDoc>()
  const input = { snapshot: p.snapshot, itemJson: p.itemJson, installCommand: p.installCommand, doc, layout: p.layout }
  const dir = outDir("build", arm, fileId(entry.id))
  const itemImports = itemImportPaths(p.itemJson)
  const attempts: Array<any> = []
  let code: string = demoRec.code
  let final = "unknown"
  for (let attempt = 0; ; attempt++) {
    writeFileSync(path.join(dir, `attempt-${attempt}.tsx`), code)
    const canRepair = attempt < MAX_REPAIRS
    const lint = lintDemo(code, itemImports)
    let problems: ReadonlyArray<string> | null = null
    let result: JobResult | null = null
    if (lint.length > 0) {
      attempts.push({ attempt, lint })
      if (!canRepair) {
        final = "Failed:lint"
        break
      }
      problems = lint
    } else {
      const jobDir = path.join(dir, `job-${attempt}`)
      mkdirSync(jobDir, { recursive: true })
      result = runJob(jobDir, {
        item: p.itemJson,
        namespace: p.namespace,
        registries: registriesMap,
        registry: regs[p.registryId]?.previewConfig ?? {},
        demo: { code, layout: p.layout },
      })
      attempts.push({ attempt, ok: result.ok, stage: result.stage, cause: result.cause, seconds: result.seconds, errors: (result.errors ?? []).slice(0, 3).map((e) => e.slice(0, 400)), diagnostics: (result.diagnostics ?? []).slice(0, 3).map((e) => e.slice(0, 400)), workarounds: result.workarounds })
      console.log(`${result.ok ? "built" : "FAIL "} ${arm} ${entry.id} attempt=${attempt} ${result.seconds.toFixed(0)}s stage=${result.stage} cause=${result.cause ?? ""} diag=${result.diagnostics?.length ?? 0} ${result.errors?.[0]?.slice(0, 160) ?? ""}`)
      if (result.ok) {
        if ((result.diagnostics?.length ?? 0) > 0 && canRepair) problems = result.diagnostics!
        else {
          final = (result.diagnostics?.length ?? 0) > 0 ? "Built:with-type-errors" : "Built"
          break
        }
      } else if (result.cause === "demo" && result.stage === "build" && canRepair) {
        problems = result.errors ?? []
      } else {
        final = `Failed:${result.cause ?? "?"}:${result.stage ?? "?"}`
        break
      }
    }
    const repaired = await Effect.runPromise(
      Effect.gen(function* () {
        const writer = yield* DemoWriter
        return yield* writer.repair(input, code, problems!)
      }).pipe(Effect.provide(layer), Effect.either),
    )
    if (repaired._tag === "Left") {
      final = `Failed:repair-error`
      attempts.push({ attempt, repairError: String((repaired.left as any).reason) })
      break
    }
    code = repaired.right.code
    attempts.at(-1).repairUsage = repaired.right.usage
  }
  report[entry.id] = { final, attempts, calls: calls.filter((c) => c.componentId === entry.id) }
  writeJson(reportFile, report)
  console.log(`=> ${arm} ${entry.id} ${final} (${attempts.length} attempts)`)
}

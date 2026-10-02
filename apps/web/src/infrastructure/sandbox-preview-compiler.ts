import { getSandbox, type Sandbox } from "@cloudflare/sandbox"
import { Effect, Layer } from "effect"
import {
  AgentError,
  type ColorScheme,
  PreviewCompiler,
  type PreviewCompileInput,
  type PreviewCompileResult,
  PreviewRenderer,
  RenderError,
} from "@shadcn-explorer/core/ports"
import { HARNESS_BUNDLE_HASH } from "./harness-bundle.gen"

/**
 * PreviewCompiler / PreviewRenderer の Cloudflare Sandbox (コンテナ) 実装。
 *
 * イメージ (preview-harness/Dockerfile) にビルド済みのハーネス (Vite + React + Tailwind v4 + shadcn)、Playwright + Chromium、
 * ffmpeg があり、
 * run-job.mjs が「リセット → レジストリのデータ → shadcn add → manifest → demo.tsx → vite build → 描画確認 → tsc」を決定的に行う。
 * LLM もシークレットもコンテナには入れない (レジストリの依存は --ignore-scripts でインストールする)。
 *
 * - コンテナは POOL_SIZE 個。コンポーネント ID のハッシュで振り分け、同じコンテナ内のジョブは flock で直列化する
 *   (ハーネスのディレクトリを共有するため)。エンリッチのキューの max_concurrency (wrangler.jsonc) より少し多くして、ハッシュの衝突による待ちを減らす
 * - sleepAfter で自動停止する (Workflow が途中で退避されても課金され続けない)。眠るまでの待機にもメモリ・ディスクが課金される
 *   (CPU だけは実際に使った分) ので、45 秒にする。3 分だと散発的な処理で 1 回ごとにビルド 3 件分を払っていた (v0.7)
 * - コンテナ (Durable Object) の ID にハーネスの内容のハッシュを入れる。デプロイ直後はイメージの更新が段階的なので、
 *   動き続けている古いコンテナで新しいハーネスのビルドをしてしまう。ハーネスが変われば必ず新しいコンテナに移る
 */
const POOL_SIZE = 6
const JOB_TIMEOUT_MS = 5 * 60_000

interface JobResult {
  readonly ok: boolean
  readonly stage: "install" | "build" | "done"
  readonly cause?: "registry" | "demo" | "harness"
  readonly errors: ReadonlyArray<string>
  readonly workarounds?: ReadonlyArray<string>
}

const slotOf = (id: string) => {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0
  return Math.abs(h) % POOL_SIZE
}

const infra = (reason: string) => new AgentError({ reason: `sandbox: ${reason}`.slice(0, 1000), retryable: true })

/**
 * ハーネスの版が一致するコンテナを取る。デプロイ直後はイメージのロールアウトが段階的で、新しい ID のコンテナでも
 * 古いイメージで起動することがあるので、イメージに焼いた版 (/opt/harness-version) を確かめ、違えば一時障害にする
 * (Workflow のリトライと backlog sweeper が後でやり直す)。
 */
/** このファイルが使う Sandbox の操作だけ (PC での一括取り込みではホストのランナーが同じ形で応える) */
interface SandboxOps {
  exec(command: string, options?: { timeout?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>
  writeFile(path: string, content: string): Promise<unknown>
  readFile(path: string, options?: { encoding?: "base64" }): Promise<{ content: string }>
}

const sandboxFor = async (namespace: DurableObjectNamespace<Sandbox>, key: string): Promise<SandboxOps> => {
  const sandbox: SandboxOps = getSandbox(namespace, `preview-${HARNESS_BUNDLE_HASH}-${slotOf(key)}`, { sleepAfter: "45s" })
  const version = await sandbox.exec("cat /opt/harness-version 2>/dev/null || true")
  if (version.stdout.trim() !== HARNESS_BUNDLE_HASH) {
    throw new Error(`container image is not rolled out yet (harness ${version.stdout.trim() || "unknown"}, want ${HARNESS_BUNDLE_HASH})`)
  }
  return sandbox
}

const jobName = (key: string) => `${key.replace(/[^a-z0-9-]/gi, "_")}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
const fromBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0))

export const SandboxPreviewCompiler = (namespace: DurableObjectNamespace<Sandbox>) =>
  Layer.succeed(PreviewCompiler, {
    name: "sandbox",
    compile: (input: PreviewCompileInput) =>
      Effect.tryPromise({
        try: async (): Promise<PreviewCompileResult> => {
          const started = Date.now()
          const sandbox = await sandboxFor(namespace, input.snapshot.id)
          const job = jobName(input.snapshot.id)
          const jobPath = `/tmp/jobs/${job}.json`
          const outPath = `/tmp/jobs/${job}.html`
          await sandbox.mkdir("/tmp/jobs", { recursive: true })
          await sandbox.writeFile(
            jobPath,
            JSON.stringify({
              item: input.itemJson,
              namespace: input.namespace,
              registries: input.registries,
              registry: input.registryConfig,
              manifest: input.manifest,
              demo: input.demo,
            }),
          )
          try {
            const exec = await sandbox.exec(
              `flock -w ${Math.round(JOB_TIMEOUT_MS / 1000)} /tmp/harness.lock node /opt/harness/run-job.mjs ${jobPath} ${outPath}`,
              { timeout: JOB_TIMEOUT_MS * 2 },
            )
            const line = exec.stdout.trim().split("\n").pop() ?? ""
            let result: JobResult
            try {
              result = JSON.parse(line) as JobResult
            } catch {
              throw new Error(`run-job exited ${exec.exitCode}: ${(exec.stderr || exec.stdout).slice(-800)}`)
            }
            const durationMs = Date.now() - started
            const workarounds = result.workarounds ?? []
            if (!result.ok) {
              return {
                _tag: "Rejected",
                stage: result.stage === "install" ? "install" : "build",
                cause: result.cause ?? "registry",
                errors: result.errors,
                workarounds,
                durationMs,
              }
            }
            const file = await sandbox.readFile(outPath)
            return { _tag: "Compiled", html: file.content, diagnostics: result.errors, workarounds, durationMs }
          } finally {
            await sandbox.exec(`rm -f ${jobPath} ${outPath}`).catch(() => undefined)
          }
        },
        catch: (e) => infra(String(e)),
      }).pipe(
        // コンテナの起動待ち・一時障害は数回まで取り直す (ビルドの失敗は Rejected で返るのでここには来ない)
        Effect.retry({ times: 2 }),
      ),
  })

/**
 * PreviewRenderer のコンテナ実装: ハーネスの render.mjs (Playwright + Chromium) で撮る。
 * 静止画 (light / dark。表示用 WebP と埋め込み用 JPEG)、描画時の例外、動き続ける部品だけ animated WebP
 * (録画を ffmpeg で実時間のまま変換) を返す。
 * ハーネスのディレクトリは触らないのでロック不要 (ビルドと同じコンテナで並行して動いてよい)。
 */
export const SandboxPreviewRenderer = (namespace: DurableObjectNamespace<Sandbox>) =>
  Layer.succeed(PreviewRenderer, {
    capture: (html, schemes, layout, options) =>
      Effect.tryPromise({
        try: async () => {
          const started = Date.now()
          const job = jobName("capture")
          const dir = `/tmp/capture/${job}`
          const sandbox = await sandboxFor(namespace, job)
          await sandbox.mkdir(dir, { recursive: true })
          try {
            await sandbox.writeFile(`${dir}/index.html`, html)
            // レジストリの既定のトークンを撮影前に注入し、要る配色だけ撮る (ダークの無いテーマはライトだけ)
            await sandbox.writeFile(`${dir}/options.json`, JSON.stringify({ tokens: options?.tokens ?? null, schemes }))
            const exec = await sandbox.exec(
              `node /opt/harness/render.mjs capture ${dir}/index.html ${dir}/out ${layout} ${dir}/options.json`,
              { timeout: 180_000 },
            )
            const line = exec.stdout.trim().split("\n").pop() ?? ""
            let result: {
              runtimeErrors: Array<string>
              shots: Array<{ scheme: ColorScheme; file: string; embedFile: string }>
              motion: Array<{ scheme: ColorScheme; file: string; durationMs: number }> | null
            }
            try {
              result = JSON.parse(line)
            } catch {
              throw new Error(`render.mjs exited ${exec.exitCode}: ${(exec.stderr || exec.stdout).slice(-800)}`)
            }
            const read = async (file: string) => fromBase64((await sandbox.readFile(`${dir}/out/${file}`, { encoding: "base64" })).content)
            const shots = []
            for (const shot of result.shots.filter((s) => schemes.includes(s.scheme))) {
              shots.push({ scheme: shot.scheme, webp: await read(shot.file), jpeg: await read(shot.embedFile) })
            }
            const motion = result.motion
              ? await Promise.all(result.motion.map(async (m) => ({ scheme: m.scheme, webp: await read(m.file), durationMs: m.durationMs })))
              : null
            return { shots, runtimeErrors: result.runtimeErrors, motion, durationMs: Date.now() - started }
          } finally {
            await sandbox.exec(`rm -rf ${dir}`).catch(() => undefined)
          }
        },
        catch: (e) => new RenderError({ reason: `sandbox: ${String(e)}`.slice(0, 500) }),
      }).pipe(Effect.retry({ times: 2 })),
  })

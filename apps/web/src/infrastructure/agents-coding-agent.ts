import { Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { UsageDoc } from "@shadcn-explorer/core/domain"
import { AgentError, type AgentInput, CodingAgent } from "@shadcn-explorer/core/ports"

/**
 * CF-Open-Agents-API (OpenAI Agents API 互換, https://github.com/inaridiy/CF-Open-Agents-API) のアダプタ。
 *
 * - 1 コンポーネント = 1 セッション。サンドボックス内で実際に `shadcn add` → デモ実装 → ビルドまで行わせ、
 *   /workspace/outputs に書かれた doc.json / preview.html を Artifact として回収する。
 * - モデルはクライアントからは「プリセット名」で指定し、実モデル (gpt-6-astra / gpt-5.6-luna など) への
 *   割り当ては Agents API 側の defineAgentWorker で行う。
 */

export type AgentsTransport = (path: string, init?: RequestInit) => Promise<Response>

const BASE = "https://agents.internal/v1"

/** Service Binding (fetchAs RPC: トークン不要) → 公開 URL + Bearer の順で使う */
export const makeAgentsTransport = (env: Env): AgentsTransport | null => {
  const binding = env.AGENTS as (Fetcher & { fetchAs?: (tenant: string, req: Request) => Promise<Response> }) | undefined
  if (binding?.fetchAs) {
    return (path, init) => binding.fetchAs!(env.AGENTS_TENANT, new Request(`${BASE}${path}`, init))
  }
  if (env.AGENTS_API_URL && env.AGENTS_API_TOKEN) {
    const base = env.AGENTS_API_URL.replace(/\/$/, "")
    return (path, init) =>
      fetch(`${base}/v1${path}`, {
        ...init,
        headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${env.AGENTS_API_TOKEN}` },
      })
  }
  return null
}

const INSTRUCTIONS = `You are a senior design-engineer who documents shadcn/ui registry items.
You work inside a Linux sandbox with Node.js. Work autonomously; never ask questions.
Always finish by writing the requested files to /workspace/outputs. Keep the final chat reply to one short sentence.`

const MAX_ITEM_JSON = 60_000

export const buildAgentPrompt = (input: AgentInput): string => {
  const { snapshot } = input
  const visual = !["hook", "lib", "file", "unknown"].includes(snapshot.kind)
  const itemJson = JSON.stringify(input.itemJson, null, 2)
  return `# Task: document the shadcn registry item "${snapshot.name}" (${snapshot.kind}) from registry "${snapshot.registryId}"

Install command: \`${input.installCommand}\`

## registry-item.json
\`\`\`json
${itemJson.length > MAX_ITEM_JSON ? `${itemJson.slice(0, MAX_ITEM_JSON)}\n... (truncated)` : itemJson}
\`\`\`

## Steps
1. Create a Vite + React + TypeScript app in /workspace/preview with Tailwind CSS v4 and run \`npx shadcn@latest init\` non-interactively.
2. Install the item with the install command above. Read the installed source to understand its real API (props, variants, sub-components).
${
  visual
    ? `3. Write src/App.tsx: a polished demo that shows the item's main variants/states. Wrap the demo in
   <div id="preview" className="flex min-h-[480px] w-[960px] items-center justify-center p-10 bg-background text-foreground">.
   Dark mode must work by adding the \`dark\` class to <html>.
4. Build a single self-contained HTML file (use vite-plugin-singlefile; no external network requests at runtime)
   and copy it to /workspace/outputs/preview.html.`
    : "3. This item is not visual; skip the preview app build."
}
5. Write /workspace/outputs/doc.json with exactly this shape (all strings in English):
{
  "summary": string,              // 1-2 sentences
  "visualDescription": string,    // what it looks like (colors, motion, style) - used for visual search
  "whenToUse": string[],
  "usage": string,                // minimal import + JSX usage (tsx)
  "examples": [{ "title": string, "description": string, "code": string }],  // 2-4 compiling examples
  "props": [{ "name": string, "type": string, "default"?: string, "description": string }],
  "accessibility": string[],
  "agentPrompt": string,          // a prompt a user can paste into a coding agent to use this item well
  "keywords": string[]            // 5-15 search keywords, include synonyms (e.g. "cta", "shiny")
}
Every code sample must type-check against the installed source (run tsc to verify).`
}

// ---------------------------------------------------------------------------
// HTTP API の最小限の型 (必要なフィールドだけ)
// ---------------------------------------------------------------------------

const Session = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  error: Schema.optional(Schema.NullOr(Schema.Unknown)),
  usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        input_tokens: Schema.optional(Schema.Number),
        output_tokens: Schema.optional(Schema.Number),
      }),
    ),
  ),
})

const ArtifactList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
})

const DocFromJson = Schema.parseJson(UsageDoc)

export interface AgentsOptions {
  readonly transport: AgentsTransport
  readonly preset: string
  readonly pollInterval?: Duration.DurationInput
  readonly timeout?: Duration.DurationInput
}

export const AgentsCodingAgent = (options: AgentsOptions) => {
  const call = <A, I>(schema: Schema.Schema<A, I>, path: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: () => options.transport(path, init),
      catch: (e) => new AgentError({ reason: `agents api unreachable: ${String(e)}`, retryable: true }),
    }).pipe(
      Effect.flatMap((res) =>
        res.ok
          ? Effect.tryPromise({
              try: () => res.json(),
              catch: () => new AgentError({ reason: "invalid json from agents api", retryable: false }),
            })
          : Effect.fail(
              new AgentError({ reason: `agents api ${path}: HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 }),
            ),
      ),
      Effect.flatMap((json) =>
        Schema.decodeUnknown(schema)(json).pipe(
          Effect.mapError((e) => new AgentError({ reason: `unexpected response: ${e.message.slice(0, 200)}`, retryable: false })),
        ),
      ),
    )

  const text = (sessionId: string, artifactId: string) =>
    Effect.tryPromise({
      try: async () => {
        const res = await options.transport(`/agents/sessions/${sessionId}/artifacts/${artifactId}/content`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.text()
      },
      catch: (e) => new AgentError({ reason: `artifact download failed: ${String(e)}`, retryable: true }),
    })

  const generate = (input: AgentInput) =>
    Effect.gen(function* () {
      const started = Date.now()
      const created = yield* call(Session, "/agents/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `doc-${input.snapshot.id}-${input.snapshot.contentHash.slice(0, 16)}`,
        },
        body: JSON.stringify({
          agent: { model: options.preset, instructions: INSTRUCTIONS },
          environment: { type: "openai_hosted" },
          input: buildAgentPrompt(input),
          metadata: { component_id: input.snapshot.id, source_hash: input.snapshot.contentHash },
          stream: false,
        }),
      })

      const cleanup = Effect.promise(() =>
        options.transport(`/agents/sessions/${created.id}`, { method: "DELETE" }).catch(() => undefined),
      )

      return yield* Effect.gen(function* () {
        // idle = ターン完了。失敗したターンも idle に戻るので error を必ず確認する
        const poll: Effect.Effect<typeof Session.Type, AgentError> = call(Session, `/agents/sessions/${created.id}`).pipe(
          Effect.flatMap((s) =>
            s.status === "in_progress"
              ? Effect.sleep(options.pollInterval ?? "10 seconds").pipe(Effect.zipRight(Effect.suspend(() => poll)))
              : Effect.succeed(s),
          ),
        )
        const finished = yield* poll.pipe(
          Effect.timeoutFail({
            duration: options.timeout ?? "15 minutes",
            onTimeout: () => new AgentError({ reason: "agent session timed out", retryable: false }),
          }),
        )
        if (finished.status === "failed" || (finished.error !== undefined && finished.error !== null)) {
          return yield* new AgentError({ reason: `agent turn failed: ${JSON.stringify(finished.error)}`, retryable: false })
        }
        if (finished.status === "requires_action") {
          return yield* new AgentError({ reason: "agent requested a client tool; not supported", retryable: false })
        }

        const artifacts = yield* call(ArtifactList, `/agents/sessions/${created.id}/artifacts`)
        const find = (name: string) => artifacts.data.find((a) => a.path.endsWith(`outputs/${name}`))
        const docArtifact = find("doc.json")
        if (!docArtifact) return yield* new AgentError({ reason: "agent did not write outputs/doc.json", retryable: false })

        const doc = yield* text(created.id, docArtifact.id).pipe(
          Effect.flatMap((raw) =>
            Schema.decodeUnknown(DocFromJson)(raw).pipe(
              Effect.mapError((e) => new AgentError({ reason: `doc.json is invalid: ${e.message.slice(0, 300)}`, retryable: false })),
            ),
          ),
        )
        const previewArtifact = find("preview.html")
        const previewHtml = previewArtifact
          ? Option.some(yield* text(created.id, previewArtifact.id))
          : Option.none<string>()

        return {
          doc,
          previewHtml,
          usage: {
            inputTokens: finished.usage?.input_tokens ?? 0,
            outputTokens: finished.usage?.output_tokens ?? 0,
            durationMs: Date.now() - started,
          },
        }
      }).pipe(Effect.ensuring(cleanup))
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("5 seconds").pipe(Schedule.intersect(Schedule.recurs(2))),
        while: (e) => e.retryable,
      }),
    )

  return Layer.succeed(CodingAgent, { presetName: options.preset, generate })
}

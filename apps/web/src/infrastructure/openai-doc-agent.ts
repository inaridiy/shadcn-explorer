import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { UsageDoc } from "@shadcn-explorer/core/domain"
import { AgentError, type AgentInput, CodingAgent } from "@shadcn-explorer/core/ports"

/**
 * OpenAI Responses API を直接呼ぶ軽量なドキュメント生成アダプタ。
 *
 * CF-Open-Agents-API (サンドボックスで実際にビルド・型検査する) が未デプロイの環境向け。
 * ソースを読んで UsageDoc を Structured Outputs で返させるだけなので、プレビュー HTML は作らない
 * (= スクショ無し。ビジュアル検索は doc テキストのベクトルのみになる)。
 */
export interface OpenAIDocAgentOptions {
  readonly apiKey: string
  readonly model: string
  /** AI Gateway 経由にする場合: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai */
  readonly baseUrl?: string
}

const str = { type: "string" } as const
const strArray = { type: "array", items: str } as const

/** Structured Outputs (strict) 用の JSON Schema。optional は null 許容で表現する */
export const usageDocJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "visualDescription", "whenToUse", "usage", "examples", "props", "accessibility", "agentPrompt", "keywords"],
  properties: {
    summary: str,
    visualDescription: str,
    whenToUse: strArray,
    usage: str,
    examples: {
      type: "array",
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
    agentPrompt: str,
    keywords: strArray,
  },
} as const

const INSTRUCTIONS = `You are a senior design-engineer who documents shadcn/ui registry items.
Read the registry item's real source code and describe its actual API precisely. Never invent props that are not in the source.
All text in English. Code samples are TSX that would type-check against the source.`

const MAX_ITEM_JSON = 80_000

export const buildDocPrompt = (input: AgentInput): string => {
  const itemJson = JSON.stringify(input.itemJson, null, 2)
  return `Document the shadcn registry item "${input.snapshot.name}" (${input.snapshot.kind}) from registry "${input.snapshot.registryId}".
Install command: ${input.installCommand}

registry-item.json:
${itemJson.length > MAX_ITEM_JSON ? `${itemJson.slice(0, MAX_ITEM_JSON)}\n... (truncated)` : itemJson}

Fill every field:
- summary: 1-2 sentences.
- visualDescription: what it looks like (colors, shape, motion, style). Used for visual search.
- whenToUse: 2-4 bullets.
- usage: ONLY TSX source (import line + minimal JSX), no prose and no markdown code fences. Installation is shown elsewhere.
- examples: 2-4 realistic examples; each code is ONLY TSX source without markdown fences.
- props: from the source's props type (default null when none).
- accessibility: concrete notes.
- agentPrompt: a prompt a user pastes into a coding agent to use this item well.
- keywords: 5-15 search keywords including synonyms (e.g. "cta", "shiny").`
}

const ResponsesOutput = Schema.Struct({
  status: Schema.optional(Schema.String),
  output: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
    }),
  ),
  usage: Schema.optional(Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number })),
})

const outputText = (res: typeof ResponsesOutput.Type) =>
  res.output
    .flatMap((o) => (o.type === "message" ? (o.content ?? []) : []))
    .filter((c) => c.type === "output_text")
    .map((c) => c.text ?? "")
    .join("")

/** Structured Outputs の null を、ドメインの optional (キー無し) に正規化する */
const normalize = (raw: unknown): unknown => {
  const doc = raw as { props?: Array<Record<string, unknown>> }
  return {
    ...doc,
    props: (doc.props ?? []).map(({ default: d, ...rest }) => (d === null || d === undefined ? rest : { ...rest, default: d })),
  }
}

export const OpenAIDocAgent = (options: OpenAIDocAgentOptions) => {
  const base = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")

  const generate = (input: AgentInput) =>
    Effect.gen(function* () {
      const started = Date.now()
      const json = yield* Effect.tryPromise({
        try: async (signal) => {
          const res = await fetch(`${base}/responses`, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
            body: JSON.stringify({
              model: options.model,
              instructions: INSTRUCTIONS,
              input: buildDocPrompt(input),
              text: { format: { type: "json_schema", name: "usage_doc", strict: true, schema: usageDocJsonSchema } },
              metadata: { component_id: input.snapshot.id },
            }),
          })
          if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status })
          return res.json()
        },
        catch: (e) =>
          new AgentError({
            reason: `openai: ${String(e)}`,
            retryable: [429, 500, 502, 503].includes((e as { status?: number }).status ?? 0),
          }),
      })
      const res = yield* Schema.decodeUnknown(ResponsesOutput)(json).pipe(
        Effect.mapError((e) => new AgentError({ reason: `unexpected response: ${e.message.slice(0, 200)}`, retryable: false })),
      )
      if (res.status && res.status !== "completed") {
        return yield* new AgentError({ reason: `response ${res.status}`, retryable: false })
      }
      const doc = yield* Effect.try({
        try: () => normalize(JSON.parse(outputText(res))),
        catch: () => new AgentError({ reason: "model output is not JSON", retryable: false }),
      }).pipe(
        Effect.flatMap((raw) =>
          Schema.decodeUnknown(UsageDoc)(raw).pipe(
            Effect.mapError((e) => new AgentError({ reason: `doc is invalid: ${e.message.slice(0, 300)}`, retryable: false })),
          ),
        ),
      )
      return {
        doc,
        previewHtml: Option.none<string>(),
        usage: {
          inputTokens: res.usage?.input_tokens ?? 0,
          outputTokens: res.usage?.output_tokens ?? 0,
          durationMs: Date.now() - started,
        },
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("2 seconds").pipe(Schedule.intersect(Schedule.recurs(2))),
        while: (e) => e.retryable,
      }),
    )

  return Layer.succeed(CodingAgent, { presetName: `openai:${options.model}`, generate })
}

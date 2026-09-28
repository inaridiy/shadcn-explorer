import { Effect, Layer, Schedule, Schema } from "effect"
import { Embedder, EmbeddingError } from "@shadcn-explorer/core/ports"

/**
 * Gemini Embedding 2 (マルチモーダル: テキストと画像が同じ埋め込み空間に入る)。
 * - task type パラメータは廃止され、テキストのプレフィックスで指示する
 *     クエリ:     "task: search result | query: {q}"
 *     ドキュメント: "title: {title} | text: {content}"
 * - Vectorize の上限 (1536 次元) に合わせて output_dimensionality を指定する (MRL で自動正規化)
 * - AI_GATEWAY_BASE_URL があれば Cloudflare AI Gateway 経由 (キャッシュ・ログ・コスト可視化)
 */
export interface GeminiOptions {
  readonly apiKey: string
  readonly model: string
  readonly dimensions: number
  /** 例: https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/google-ai-studio */
  readonly gatewayBaseUrl?: string
  readonly gatewayToken?: string
}

const EmbedResponse = Schema.Struct({ embedding: Schema.Struct({ values: Schema.Array(Schema.Number) }) })

type Part = { text: string } | { inline_data: { mime_type: string; data: string } }

const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

const sniffMime = (bytes: Uint8Array) => (bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png")

export const GeminiEmbedder = (options: GeminiOptions) => {
  const base = (options.gatewayBaseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/, "")
  const url = `${base}/v1beta/models/${options.model}:embedContent`

  const embed = (parts: ReadonlyArray<Part>) =>
    Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(url, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": options.apiKey,
            ...(options.gatewayToken ? { "cf-aig-authorization": `Bearer ${options.gatewayToken}` } : {}),
          },
          body: JSON.stringify({ content: { parts }, output_dimensionality: options.dimensions }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
        return res.json()
      },
      catch: (e) => new EmbeddingError({ reason: String(e) }),
    }).pipe(
      Effect.flatMap((json) =>
        Schema.decodeUnknown(EmbedResponse)(json).pipe(
          Effect.mapError((e) => new EmbeddingError({ reason: e.message.slice(0, 200) })),
        ),
      ),
      Effect.map((r) => r.embedding.values),
      Effect.retry({
        schedule: Schedule.exponential("500 millis").pipe(Schedule.intersect(Schedule.recurs(3))),
        while: (e) => /HTTP (429|5\d\d)/.test(e.reason),
      }),
    )

  return Layer.succeed(Embedder, {
    model: options.model,
    embedQuery: (text) => embed([{ text: `task: search result | query: ${text}` }]),
    embedDocument: (title, text) => embed([{ text: `title: ${title || "none"} | text: ${text.slice(0, 20_000)}` }]),
    embedImage: (png) => embed([{ inline_data: { mime_type: sniffMime(png), data: toBase64(png) } }]),
  })
}

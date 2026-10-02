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

/**
 * クエリ埋め込みのキャッシュ。検索の待ち時間のうち埋め込みは 300ms 前後あり、同じクエリ (例のチップ・人気の語) は何度も来る。
 * isolate 内の小さな LRU → コロ単位の Cache API の順に引く。ベクトルは Float32 のバイナリで持つ (1536 次元で 6KB)
 */
const QUERY_CACHE_TTL_SECONDS = 30 * 24 * 3600
const MEMORY_ENTRIES = 256
const memory = new Map<string, ReadonlyArray<number>>()

const normalizeQuery = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()

const sha256Hex = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

const edgeCache = () => {
  try {
    // DOM の lib と型が衝突するので Workers の caches.default を明示する
    return (caches as unknown as { default: Cache }).default
  } catch {
    return null
  }
}

const cachedQuery = (
  scope: string,
  text: string,
  compute: Effect.Effect<ReadonlyArray<number>, EmbeddingError>,
): Effect.Effect<ReadonlyArray<number>, EmbeddingError> =>
  Effect.gen(function* () {
    const normalized = normalizeQuery(text)
    const fromMemory = memory.get(`${scope}|${normalized}`)
    if (fromMemory) return fromMemory
    const key = yield* Effect.promise(() => sha256Hex(`${scope}|${normalized}`))
    const request = new Request(`https://query-embeddings.invalid/${key}`)
    const cache = edgeCache()
    const hit = cache ? yield* Effect.promise(() => cache.match(request).catch(() => undefined)) : undefined
    const remember = (values: ReadonlyArray<number>) => {
      memory.delete(`${scope}|${normalized}`)
      memory.set(`${scope}|${normalized}`, values)
      if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value!)
      return values
    }
    if (hit) return remember([...new Float32Array(yield* Effect.promise(() => hit.arrayBuffer()))])
    const values = yield* compute
    if (cache) {
      const body = new Float32Array(values).buffer
      yield* Effect.promise(() =>
        cache
          .put(request, new Response(body, { headers: { "cache-control": `public, max-age=${QUERY_CACHE_TTL_SECONDS}` } }))
          .catch(() => undefined),
      )
    }
    return remember(values)
  })

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
    embedQuery: (text) =>
      cachedQuery(`${options.model}/${options.dimensions}`, text, embed([{ text: `task: search result | query: ${normalizeQuery(text)}` }])),
    embedDocument: (title, text) => embed([{ text: `title: ${title || "none"} | text: ${text.slice(0, 20_000)}` }]),
    embedImage: (png) => embed([{ inline_data: { mime_type: sniffMime(png), data: toBase64(png) } }]),
  })
}

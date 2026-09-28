import { Effect, Layer, Schedule } from "effect"
import { parsePublicHttpsUrl } from "@shadcn-explorer/core/domain"
import { RegistryFetchError, RegistryHttp } from "@shadcn-explorer/core/ports"

const MAX_BYTES = 5 * 1024 * 1024
const TIMEOUT_MS = 15_000

/**
 * 外部レジストリの取得。
 * - https / 公開ドメインのみ (ドメイン層の検証を再利用)
 * - サイズ上限・タイムアウト付き
 * - 5xx とネットワークエラーのみ指数バックオフで再試行
 */
export const FetchRegistryHttp = Layer.succeed(RegistryHttp, {
  getJson: (url) =>
    Effect.gen(function* () {
      const parsed = parsePublicHttpsUrl(url)
      if (parsed._tag === "Left") return yield* new RegistryFetchError({ url, reason: parsed.left.reason })

      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            headers: { accept: "application/json", "user-agent": "shadcn-explorer/0.1 (+https://github.com/inaridiy/shadcn-explorer)" },
            redirect: "follow",
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          }),
        catch: (e) => new RegistryFetchError({ url, reason: `network error: ${String(e)}` }),
      })
      if (!response.ok) {
        return yield* new RegistryFetchError({ url, reason: `HTTP ${response.status}`, status: response.status })
      }
      const length = Number(response.headers.get("content-length") ?? "0")
      if (length > MAX_BYTES) return yield* new RegistryFetchError({ url, reason: "レスポンスが大きすぎます" })

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new RegistryFetchError({ url, reason: String(e) }),
      })
      if (text.length > MAX_BYTES) return yield* new RegistryFetchError({ url, reason: "レスポンスが大きすぎます" })
      return yield* Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () => new RegistryFetchError({ url, reason: "JSON ではありません" }),
      })
    }).pipe(
      Effect.retry({
        schedule: Schedule.exponential("300 millis").pipe(Schedule.intersect(Schedule.recurs(2))),
        while: (e) => e.status === undefined ? e.reason.startsWith("network") : e.status >= 500,
      }),
    ),
})

import { Hono } from "hono"
import { cors } from "hono/cors"
import { Effect, Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { ComponentId, ComponentKind, RegistryId, SearchQuery, UserId } from "@shadcn-explorer/core/domain"
import type { AppServices } from "~/infrastructure/layers"
import { getAuth } from "~/lib/auth"
import { describeError, runApp } from "~/lib/runtime"
import { toCard, toDetailDto, toRegistryDto, toSearchResultDto } from "~/server/dto"
import { handleMcp } from "./mcp"
import { storeSearchImage } from "./uploads"

/**
 * アプリ外向けのバックエンド (Hono)。
 *   /api/auth/*  Better Auth
 *   /api/v1/*    REST API (API キー or セッション)
 *   /mcp         MCP (Streamable HTTP, stateless)
 *   /media/*     R2 のスクショ・プレビュー配信
 */

type Variables = { userId: string }

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth().handler(c.req.raw))

// ---------------------------------------------------------------------------
// 認証: x-api-key (外部クライアント / Coding Agent) か、セッション Cookie (同一オリジンの UI)
// ---------------------------------------------------------------------------

type AuthResult =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly status: 401 | 429; readonly message: string }

const authenticate = async (request: Request): Promise<AuthResult> => {
  const auth = getAuth()
  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (key) {
    const result = await auth.api.verifyApiKey({ body: { key } })
    if (result.valid && result.key) return { ok: true, userId: result.key.referenceId }
    const code = (result.error as { code?: string } | null)?.code
    return code === "RATE_LIMITED"
      ? { ok: false, status: 429, message: "レート制限を超えました。しばらく待ってから再試行してください" }
      : { ok: false, status: 401, message: "API キーが無効です" }
  }
  const session = await auth.api.getSession({ headers: request.headers })
  return session ? { ok: true, userId: session.user.id } : { ok: false, status: 401, message: "x-api-key ヘッダーが必要です" }
}

const v1 = new Hono<{ Bindings: Env; Variables: Variables }>()
v1.use("*", cors({ origin: "*", allowHeaders: ["x-api-key", "authorization", "content-type"] }))
v1.use("*", async (c, next) => {
  const auth = await authenticate(c.req.raw)
  if (!auth.ok) return c.json({ error: { code: auth.status === 429 ? "RATE_LIMITED" : "UNAUTHORIZED", message: auth.message } }, auth.status)
  c.set("userId", auth.userId)
  return next()
})

/** Effect の結果を HTTP レスポンスに写す */
const respond = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, AppServices>,
  map: (a: A) => unknown = (a) => a,
) => {
  const result = await runApp(effect)
  if (result._tag === "Success") return Response.json(map(result.value))
  const info = result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 }
  return Response.json({ error: { code: info.code, message: info.message } }, { status: info.status })
}

const csv = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined)

const decodeSearchQuery = Schema.decodeUnknownEither(SearchQuery)

v1.get("/search", (c) => {
  const kinds = csv(c.req.query("kind"))
  const registries = csv(c.req.query("registry"))
  const parsed = decodeSearchQuery({
    _tag: "Text",
    text: c.req.query("q") ?? "",
    mode: c.req.query("mode") ?? "hybrid",
    filters: { ...(kinds ? { kinds } : {}), ...(registries ? { registryIds: registries } : {}) },
    limit: Number(c.req.query("limit") ?? 20),
  })
  if (parsed._tag === "Left") return c.json({ error: { code: "BAD_REQUEST", message: parsed.left.message } }, 400)
  return respond(Application.searchComponents(parsed.right), toSearchResultDto)
})

v1.post("/search/image", async (c) => {
  const form = await c.req.formData()
  const stored = await storeSearchImage(form.get("image"))
  if (!stored.ok) return c.json({ error: { code: "BAD_REQUEST", message: stored.message } }, 400)
  return respond(
    Application.searchComponents({ _tag: "Image", imageKey: stored.key, filters: {}, limit: Number(form.get("limit") ?? 20) }),
    toSearchResultDto,
  )
})

v1.get("/components", (c) => {
  const kinds = csv(c.req.query("kind"))
  const decodedKinds = kinds ? Schema.decodeUnknownEither(Schema.Array(ComponentKind))(kinds) : undefined
  if (decodedKinds?._tag === "Left") return c.json({ error: { code: "BAD_REQUEST", message: "invalid kind" } }, 400)
  const registry = c.req.query("registry")
  return respond(
    Application.browseComponents({
      ...(registry ? { registryId: RegistryId.make(registry) } : {}),
      ...(decodedKinds ? { kinds: decodedKinds.right } : {}),
      limit: Math.min(Number(c.req.query("limit") ?? 50), 100),
      offset: Number(c.req.query("offset") ?? 0),
    }),
    (records) => ({ components: records.map(toCard) }),
  )
})

v1.get("/components/:registryId/:name", (c) =>
  respond(
    Application.getComponentDetail(ComponentId.make(`${c.req.param("registryId")}:${c.req.param("name")}`)),
    toDetailDto,
  ),
)

/** ドキュメント・プレビューの再生成を要求 (レジストリ登録者のみ) */
v1.post("/components/:registryId/:name/enrich", (c) =>
  respond(
    Application.requestEnrichment(
      ComponentId.make(`${c.req.param("registryId")}:${c.req.param("name")}`),
      UserId.make(c.get("userId")),
    ),
    () => ({ scheduled: true }),
  ),
)

v1.get("/registries", (c) =>
  respond(Application.listRegistries, (list) => ({
    registries: list.map((r) => toRegistryDto(r.registry, r.componentCount)),
  })),
)

v1.post("/registries", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { url?: unknown }
  if (typeof body.url !== "string") return c.json({ error: { code: "BAD_REQUEST", message: "url is required" } }, 400)
  return respond(Application.registerRegistry(body.url, UserId.make(c.get("userId"))), (r) => toRegistryDto(r))
})

app.route("/api/v1", v1)

// ---------------------------------------------------------------------------
// MCP (Coding Agent から「コンポーネントを探して使う」ためのツール群)
// ---------------------------------------------------------------------------

app.post("/mcp", async (c) => {
  const auth = await authenticate(c.req.raw)
  if (!auth.ok) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: auth.message } }, auth.status)
  return handleMcp(c.req.raw, new URL(c.req.url).origin)
})
app.get("/mcp", (c) => c.body(null, 405, { allow: "POST" }))

// ---------------------------------------------------------------------------
// Media (R2)
// ---------------------------------------------------------------------------

app.get("/media/*", async (c) => {
  const key = c.req.path.replace(/^\/media\//, "")
  // アップロード画像は公開しない
  if (!/^(screenshots|previews)\//.test(key)) return c.notFound()
  const object = await c.env.MEDIA.get(key)
  if (!object) return c.notFound()
  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set("etag", object.httpEtag)
  if (key.startsWith("previews/")) {
    // Agent が生成した HTML は信頼しない: 不透明オリジンのサンドボックスで実行させ、外部通信も禁止する
    headers.set(
      "content-security-policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:",
    )
    headers.set("x-content-type-options", "nosniff")
  }
  return new Response(object.body, { headers })
})

export default app

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

/** userId = null は匿名 (IP 単位のレート制限付きで読み取りのみ許可) */
type Variables = { userId: string | null }

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

app.on(["GET", "POST"], "/api/auth/*", (c) => getAuth().handler(c.req.raw))

// ---------------------------------------------------------------------------
// 認証
//   x-api-key   : 外部クライアント / Coding Agent。キー単位のレート制限 (Better Auth)
//   セッション  : 同一オリジンの UI
//   匿名        : 公開データの読み取り (REST GET / MCP) だけ。IP 単位のレート制限 (Workers Rate Limiting)
// ---------------------------------------------------------------------------

type AuthResult =
  | { readonly ok: true; readonly userId: string | null }
  | { readonly ok: false; readonly status: 401 | 429; readonly message: string }

const RATE_LIMITED = { ok: false, status: 429, message: "レート制限を超えました。しばらく待ってから再試行してください" } as const

const authenticate = async (request: Request, env: Env): Promise<AuthResult> => {
  const auth = getAuth()
  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
  if (key) {
    const result = await auth.api.verifyApiKey({ body: { key } })
    if (result.valid && result.key) return { ok: true, userId: result.key.referenceId }
    const code = (result.error as { code?: string } | null)?.code
    return code === "RATE_LIMITED" ? RATE_LIMITED : { ok: false, status: 401, message: "API キーが無効です" }
  }
  const session = await auth.api.getSession({ headers: request.headers })
  if (session) return { ok: true, userId: session.user.id }
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown"
  const { success } = await env.ANON_RATE_LIMITER.limit({ key: `anon:${ip}` })
  return success ? { ok: true, userId: null } : RATE_LIMITED
}

const v1 = new Hono<{ Bindings: Env; Variables: Variables }>()
v1.use("*", cors({ origin: "*", allowHeaders: ["x-api-key", "authorization", "content-type"] }))
v1.use("*", async (c, next) => {
  const auth = await authenticate(c.req.raw, c.env)
  if (!auth.ok) return c.json({ error: { code: auth.status === 429 ? "RATE_LIMITED" : "UNAUTHORIZED", message: auth.message } }, auth.status)
  // 書き込み (登録・再生成・画像アップロード) は識別できる利用者のみ
  if (auth.userId === null && c.req.method !== "GET") {
    return c.json({ error: { code: "UNAUTHORIZED", message: "この操作には x-api-key またはログインが必要です" } }, 401)
  }
  c.set("userId", auth.userId)
  return next()
})

/** 書き込み系ハンドラ用: ミドルウェアで匿名を弾いているので非 null */
const requireUser = (userId: string | null) => UserId.make(userId ?? "")

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
      requireUser(c.get("userId")),
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
  return respond(Application.registerRegistry(body.url, requireUser(c.get("userId"))), (r) => toRegistryDto(r))
})

app.route("/api/v1", v1)

// ---------------------------------------------------------------------------
// MCP (Coding Agent から「コンポーネントを探して使う」ためのツール群)
// ---------------------------------------------------------------------------

// 読み取り専用のツールだけなので匿名でも使える (IP 単位のレート制限)。API キーで上限が上がる
app.post("/mcp", async (c) => {
  const auth = await authenticate(c.req.raw, c.env)
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

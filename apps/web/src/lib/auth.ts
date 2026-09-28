import { apiKey } from "@better-auth/api-key"
import { betterAuth } from "better-auth"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { env } from "cloudflare:workers"

/**
 * Better Auth (D1 をネイティブアダプタで直接利用)。
 * - Web UI: GitHub OAuth / メール+パスワード (セッション Cookie)
 * - REST / MCP: API キー (x-api-key)。キー単位でレート制限をかけ、検索の埋め込みコストを抑える
 */
const createAuth = () =>
  betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET ?? "local-dev-secret-change-me-local-dev-secret",
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: true },
    socialProviders:
      env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } }
        : {},
    plugins: [
      apiKey({
        defaultPrefix: "sce_",
        rateLimit: { enabled: true, timeWindow: 60 * 1000, maxRequests: 60 },
      }),
      // TanStack Start の server fn からの Set-Cookie を反映する (必ず最後)
      tanstackStartCookies(),
    ],
  })

let auth: ReturnType<typeof createAuth> | undefined
export const getAuth = () => (auth ??= createAuth())
export type Auth = ReturnType<typeof createAuth>

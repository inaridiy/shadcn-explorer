import { env } from "cloudflare:workers"

/**
 * 運営者 (管理者) の判定。レジストリの登録・再同期・再生成・プレビュー設定は運営者だけが行う。
 * ADMIN_USER_IDS は Better Auth のユーザー ID のカンマ区切り。メール+パスワード登録はメール確認をしないので、
 * メールアドレスでは判定しない (他人が同じアドレスで登録できてしまう)。
 */
const adminIds = () =>
  new Set(
    (env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )

export const isAdmin = (userId: string | null | undefined): boolean => userId != null && adminIds().has(userId)


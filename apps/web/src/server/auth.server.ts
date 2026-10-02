import { getRequestHeaders } from "@tanstack/react-start/server"
import { UserId } from "@shadcn-explorer/core/domain"
import { isAdmin } from "~/lib/admin"
import { getAuth } from "~/lib/auth"
import { AppError } from "~/lib/runtime"

/** server fn のハンドラ内からのみ使う (*.server.ts はクライアントバンドルに入らない) */
export const currentUser = async () => {
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() as unknown as Headers })
  return session
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
        isAdmin: isAdmin(session.user.id),
      }
    : null
}

export const requireUserId = async () => {
  const user = await currentUser()
  if (!user) throw new AppError({ code: "UNAUTHORIZED", message: "ログインが必要です", status: 401 })
  return UserId.make(user.id)
}

/** 運営者だけが行う操作 (登録・再同期・再生成・プレビュー設定) */
export const requireAdmin = async () => {
  const userId = await requireUserId()
  if (!isAdmin(userId)) throw new AppError({ code: "FORBIDDEN", message: "運営者のみ実行できます", status: 403 })
  return userId
}

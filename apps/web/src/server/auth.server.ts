import { getRequestHeaders } from "@tanstack/react-start/server"
import { UserId } from "@shadcn-explorer/core/domain"
import { getAuth } from "~/lib/auth"
import { AppError } from "~/lib/runtime"

/** server fn のハンドラ内からのみ使う (*.server.ts はクライアントバンドルに入らない) */
export const currentUser = async () => {
  const session = await getAuth().api.getSession({ headers: getRequestHeaders() as unknown as Headers })
  return session
    ? { id: session.user.id, name: session.user.name, email: session.user.email, image: session.user.image ?? null }
    : null
}

export const requireUserId = async () => {
  const user = await currentUser()
  if (!user) throw new AppError({ code: "UNAUTHORIZED", message: "ログインが必要です", status: 401 })
  return UserId.make(user.id)
}

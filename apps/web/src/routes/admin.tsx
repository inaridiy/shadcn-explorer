import { Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router"

/** 管理画面のレイアウト。運営者 (ADMIN_USER_IDS) 以外には存在自体を見せない */
export const Route = createFileRoute("/admin")({
  beforeLoad: ({ context, location }) => {
    if (!context.user) throw redirect({ to: "/login", search: { redirect: location.href } })
    if (!context.user.isAdmin) throw notFound()
  },
  component: Outlet,
})

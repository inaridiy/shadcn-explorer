/// <reference types="vite/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router"
import type * as React from "react"
import { SiteHeader } from "~/components/site-header"
import { getSessionFn } from "~/server/session"
import appCss from "~/styles/app.css?url"

const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await getSessionFn() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Shadcn Explorer — search every shadcn registry" },
      {
        name: "description",
        content: "Register shadcn registries and search every component across them with BM25, semantic and multimodal search.",
      },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
  notFoundComponent: () => (
    <div className="mx-auto max-w-7xl px-4 py-24 text-center">
      <p className="text-lg font-semibold">Not found</p>
      <Link to="/" className="text-sm text-muted-foreground underline">
        Back to search
      </Link>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-7xl px-4 py-24 text-center">
      <p className="text-lg font-semibold">Something went wrong</p>
      <p className="mt-2 text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
    </div>
  ),
})

function RootLayout() {
  const { user } = Route.useRouteContext()
  return (
    <>
      <SiteHeader user={user} />
      <main className="mx-auto w-full max-w-7xl px-4 pb-24">
        <Outlet />
      </main>
    </>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="min-h-dvh">
        {children}
        <Scripts />
      </body>
    </html>
  )
}

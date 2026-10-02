/// <reference types="vite/client" />
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from "@tanstack/react-router"
import type * as React from "react"
import { CommandPaletteProvider } from "~/components/command-palette"
import { SiteHeader } from "~/components/site-header"
import { socialMeta } from "~/lib/seo"
import { getSessionFn } from "~/server/session"
import appCss from "~/styles/app.css?url"

const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");if(t==="dark"||(!t&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`

const SITE_DESCRIPTION =
  "Browse and search components from every shadcn registry, each built and running live, with docs, install commands and an MCP server."

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await getSessionFn() }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "shadcn explorer — every shadcn registry, running live" },
      { name: "description", content: SITE_DESCRIPTION },
      // 既定のカード画像はプロモ動画の冒頭の 1 コマ (public/og.png、1200×630)
      ...socialMeta({ title: "Shadcn Explorer — every shadcn registry, running live", description: SITE_DESCRIPTION, image: "/og.png", path: "/" }),
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap" },
      { rel: "stylesheet", href: appCss },
    ],
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
    <CommandPaletteProvider>
      <SiteHeader user={user} />
      <main className="mx-auto w-full max-w-[1360px] px-4 pb-24 sm:px-8">
        <Outlet />
      </main>
    </CommandPaletteProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
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

import { Link } from "@tanstack/react-router"
import { Moon, Search, Sun } from "lucide-react"
import { Button, buttonVariants } from "~/components/ui/button"
import { usePalette } from "./command-palette"
import { SignalDot } from "./listing-badge"
import { LogoMark } from "./logo"

export function ThemeToggle() {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => {
        const dark = document.documentElement.classList.toggle("dark")
        try {
          localStorage.setItem("theme", dark ? "dark" : "light")
        } catch {}
      }}
    >
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  )
}

const navLink = "whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground [&.active]:text-foreground"

export function SiteHeader({ user }: { user: { name: string; isAdmin: boolean } | null }) {
  const palette = usePalette()
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex h-15 max-w-[1360px] items-center gap-4 px-4 sm:gap-7 sm:px-8">
        <Link to="/" className="flex shrink-0 items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <LogoMark />
          <span className="hidden sm:inline">shadcn explorer</span>
        </Link>
        <nav className="flex min-w-0 items-center gap-4 overflow-x-auto text-sm sm:gap-5.5 [scrollbar-width:none]">
          <Link to="/" className={navLink} activeOptions={{ exact: true }}>
            Explore
          </Link>
          <Link to="/registries" className={`${navLink} hidden sm:inline`}>
            Registries
          </Link>
          <Link to="/live" className={`${navLink} inline-flex items-center gap-1.5`}>
            <SignalDot pulse />
            Live
          </Link>
          <Link to="/settings" className={`${navLink} hidden md:inline`}>
            API &amp; MCP
          </Link>
          {user?.isAdmin && (
            <Link to="/admin" className={navLink}>
              Admin
            </Link>
          )}
        </nav>
        <button
          type="button"
          onClick={palette.open}
          className="ml-auto hidden h-9.5 w-full max-w-[360px] items-center gap-2.5 rounded-[9px] border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-ring md:flex"
        >
          <Search className="size-[15px]" />
          <span className="flex-1 truncate text-left">Search, or paste a screenshot</span>
          <kbd className="rounded-[5px] border px-1.5 font-mono text-[11px]">⌘K</kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Search" onClick={palette.open}>
            <Search />
          </Button>
          <span className="hidden sm:contents">
            <ThemeToggle />
          </span>
          {user ? (
            <span className="hidden max-w-32 truncate text-sm text-muted-foreground sm:inline">{user.name}</span>
          ) : (
            <Link to="/login" className={buttonVariants({ size: "sm" })}>
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  )
}

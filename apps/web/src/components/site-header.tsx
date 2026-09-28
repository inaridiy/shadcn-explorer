import { Link } from "@tanstack/react-router"
import { Blocks, Moon, Sun } from "lucide-react"
import { Button, buttonVariants } from "~/components/ui/button"

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

export function SiteHeader({ user }: { user: { name: string } | null }) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <Blocks className="size-5 text-brand" />
          Shadcn Explorer
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link to="/" className="hover:text-foreground [&.active]:text-foreground" activeOptions={{ exact: true }}>
            Search
          </Link>
          <Link to="/registries" className="hover:text-foreground [&.active]:text-foreground">
            Registries
          </Link>
          <Link to="/settings" className="hover:text-foreground [&.active]:text-foreground">
            API & MCP
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {user ? (
            <span className="text-sm text-muted-foreground">{user.name}</span>
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

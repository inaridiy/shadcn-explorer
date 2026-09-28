import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Loader2 } from "lucide-react"
import * as React from "react"
import { Schema } from "effect"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { Input } from "~/components/ui/input"
import { authClient } from "~/lib/auth-client"

export const Route = createFileRoute("/login")({
  validateSearch: (input) =>
    Schema.decodeUnknownSync(Schema.Struct({ redirect: Schema.optional(Schema.String) }))(input, { onExcessProperty: "ignore" }),
  component: LoginPage,
})

const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.9 1.2 1.9 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.7 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
  </svg>
)

function LoginPage() {
  const { redirect } = Route.useSearch()
  const router = useRouter()
  const [mode, setMode] = React.useState<"signIn" | "signUp">("signIn")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)
  // オープンリダイレクト防止: 同一オリジンのパスのみ
  const target = redirect?.startsWith("/") && !redirect.startsWith("//") ? redirect : "/"

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const email = String(form.get("email"))
    const password = String(form.get("password"))
    setPending(true)
    setError(null)
    const result =
      mode === "signIn"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(form.get("name") || email.split("@")[0]) })
    setPending(false)
    if (result.error) return setError(result.error.message ?? "Failed")
    await router.invalidate()
    await router.navigate({ to: target })
  }

  return (
    <div className="mx-auto max-w-sm pt-16">
      <Card>
        <CardHeader>
          <CardTitle>{mode === "signIn" ? "Sign in" : "Create account"}</CardTitle>
          <CardDescription>Sign in to register registries and create API keys.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Button variant="outline" onClick={() => authClient.signIn.social({ provider: "github", callbackURL: target })}>
            <GitHubIcon /> Continue with GitHub
          </Button>
          <div className="text-center text-xs text-muted-foreground">or</div>
          <form onSubmit={submit} className="flex flex-col gap-3">
            {mode === "signUp" && <Input name="name" placeholder="Name" autoComplete="name" />}
            <Input name="email" type="email" placeholder="Email" required autoComplete="email" />
            <Input name="password" type="password" placeholder="Password" required minLength={8} autoComplete={mode === "signIn" ? "current-password" : "new-password"} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="animate-spin" />}
              {mode === "signIn" ? "Sign in" : "Sign up"}
            </Button>
          </form>
          <button type="button" className="text-sm text-muted-foreground underline" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
            {mode === "signIn" ? "Create an account" : "Have an account? Sign in"}
          </button>
        </CardContent>
      </Card>
    </div>
  )
}

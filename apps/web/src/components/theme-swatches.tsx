import { SWATCH_TOKENS, type ThemeTokensDto } from "~/lib/theme"

/** トークンの色見本 (ライト / ダーク)。値は検証済みのトークンだが、style には色として解釈できるものだけ効く */
export function ThemeSwatches({ tokens }: { tokens: ThemeTokensDto }) {
  const row = (label: string, map: Readonly<Record<string, string>> | undefined) => {
    const names = SWATCH_TOKENS.filter((n) => map?.[n])
    if (!map || names.length === 0) return null
    return (
      <div className="flex items-center gap-2">
        <span className="w-10 text-xs text-muted-foreground">{label}</span>
        <div className="flex gap-1">
          {names.map((n) => (
            <span key={n} title={`${n}: ${map[n]}`} className="size-5 rounded border" style={{ background: map[n] }} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      {row("light", tokens.light)}
      {row("dark", tokens.dark)}
    </div>
  )
}

import { useRouter } from "@tanstack/react-router"
import { Check, Loader2, RefreshCw, X } from "lucide-react"
import * as React from "react"
import { ThemeSwatches } from "~/components/theme-swatches"
import { Badge } from "~/components/ui/badge"
import { Button } from "~/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card"
import { formatDate } from "~/components/registry-status"
import type { RegistryDto } from "~/server/dto"
import { approveThemeFn, redetectThemeFn, rejectThemeFn } from "~/server/registries"

const SOURCE_LABEL: Record<string, string> = {
  "registry-item": "registry.json のスタイル",
  agent: "インストール手順 (エージェント)",
  manual: "運営者の手入力",
  none: "テーマなし (neutral)",
}

/**
 * テーマの判定状態と、承認待ちの提案 (運営者のみ)。
 * 提案は根拠 (ドキュメントの引用)・トークンの色見本・入れるアイテムを見て承認する。承認するとビジュアルなアイテムを
 * ビルドし直す (デモは再利用、LLM は使わない)。
 */
export function RegistryThemePanel({ registry }: { registry: RegistryDto }) {
  const router = useRouter()
  const [pending, setPending] = React.useState<"approve" | "reject" | "redetect" | null>(null)
  const [message, setMessage] = React.useState<string | null>(null)
  const theme = registry.theme

  const act = async (kind: "approve" | "reject" | "redetect") => {
    setPending(kind)
    setMessage(null)
    const fn = kind === "approve" ? approveThemeFn : kind === "reject" ? rejectThemeFn : redetectThemeFn
    const result = await fn({ data: { registryId: registry.id } })
    setPending(null)
    if (!result.ok) setMessage(result.error.message)
    else {
      setMessage(kind === "redetect" ? "Theme detection scheduled" : kind === "approve" ? "Applied. Previews are being rebuilt." : "Rejected")
      await router.invalidate()
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="flex items-center gap-2">
            Theme <Badge variant="outline">{theme._tag}</Badge>
          </CardTitle>
          <CardDescription>
            {theme._tag === "Resolved" && `${SOURCE_LABEL[theme.source] ?? theme.source} · ${formatDate(theme.resolvedAt)} — ${theme.note}`}
            {theme._tag === "AgentPending" && `エージェントがインストール手順を調べています (${formatDate(theme.startedAt)} から)。その間このレジストリのプレビューは保留中`}
            {theme._tag === "Failed" && `判定に失敗: ${theme.reason}`}
            {theme._tag === "Unresolved" && "まだ判定していません (次の同期で判定します)"}
            {theme._tag === "Proposed" && "承認待ちの提案があります"}
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => act("redetect")}>
          {pending === "redetect" ? <Loader2 className="animate-spin" /> : <RefreshCw />} Re-detect
        </Button>
      </CardHeader>
      {theme._tag === "Proposed" && (
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{SOURCE_LABEL[theme.proposal.source]}</Badge>
            <Badge variant="secondary">confidence: {theme.proposal.confidence}</Badge>
          </div>
          <p className="whitespace-pre-wrap text-muted-foreground">{theme.proposal.notes}</p>
          {theme.proposal.config.tokens && <ThemeSwatches tokens={theme.proposal.config.tokens} />}
          <dl className="grid gap-1 font-mono text-xs">
            {theme.proposal.config.baseItems?.map((b) => (
              <div key={b}>
                <dt className="inline text-muted-foreground">baseItem: </dt>
                <dd className="inline break-all">{b}</dd>
              </div>
            ))}
            {theme.proposal.config.fonts?.length ? (
              <div>
                <dt className="inline text-muted-foreground">fonts: </dt>
                <dd className="inline">{theme.proposal.config.fonts.join(", ")}</dd>
              </div>
            ) : null}
            {theme.proposal.config.themeVars && (
              <div>
                <dt className="inline text-muted-foreground">themeVars: </dt>
                <dd className="inline break-all">{Object.keys(theme.proposal.config.themeVars).join(", ")}</dd>
              </div>
            )}
            {theme.proposal.config.variants?.length ? (
              <div>
                <dt className="inline text-muted-foreground">variants: </dt>
                <dd className="inline">{theme.proposal.config.variants.map((v) => v.name).join(", ")}</dd>
              </div>
            ) : null}
            {theme.proposal.config.css && (
              <div>
                <dt className="text-muted-foreground">css:</dt>
                <dd>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2">{theme.proposal.config.css}</pre>
                </dd>
              </div>
            )}
          </dl>
          {theme.proposal.evidence.length > 0 && (
            <ul className="grid gap-2">
              {theme.proposal.evidence.map((e) => (
                <li key={`${e.url}:${e.quote}`} className="rounded-lg border p-2">
                  <a href={e.url} target="_blank" rel="noreferrer" className="break-all font-mono text-xs underline">
                    {e.url}
                  </a>
                  <blockquote className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{e.quote}</blockquote>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button disabled={pending !== null} onClick={() => act("approve")}>
              {pending === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve and rebuild previews
            </Button>
            <Button variant="outline" disabled={pending !== null} onClick={() => act("reject")}>
              {pending === "reject" ? <Loader2 className="animate-spin" /> : <X />} Reject
            </Button>
          </div>
        </CardContent>
      )}
      {message && <CardContent className="pt-0 text-sm text-muted-foreground">{message}</CardContent>}
    </Card>
  )
}

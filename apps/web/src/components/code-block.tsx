import { highlight } from "sugar-high"
import * as React from "react"
import { cn } from "~/lib/utils"
import { CopyButton } from "./copy-button"

/**
 * コードの表示 (シンタックスハイライト付き)。sugar-high は小さく、SSR でもクライアントでも同じ HTML を返す
 * (出力はエスケープ済みなので、レジストリ由来のコードでもそのまま埋め込める)。地はテーマに関わらず暗い
 */
export function HighlightedCode({ code, lineNumbers = false, className }: { code: string; lineNumbers?: boolean; className?: string }) {
  // 行は span (display: block) で区切られるので、行間の改行文字は捨てる (残すと pre の中で空行が挟まる)
  const html = React.useMemo(() => highlight(code.replace(/\n$/, "")).replace(/<\/span>\n<span class="sh__line">/g, '</span><span class="sh__line">'), [code])
  return (
    <pre className={cn("code-surface overflow-auto font-mono text-[13px] leading-relaxed", lineNumbers && "with-lines", className)}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sugar-high escapes its input */}
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

export function CodeBlock({
  code,
  title,
  className,
  lineNumbers = true,
}: {
  code: string
  title?: string
  className?: string
  lineNumbers?: boolean
}) {
  return (
    <div className={cn("code-surface overflow-hidden rounded-xl border border-zinc-800", className)}>
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2">
        <span className="font-mono text-xs text-zinc-400">{title ?? ""}</span>
        <CopyButton value={code} className="text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" />
      </div>
      <HighlightedCode code={code} lineNumbers={lineNumbers} className="max-h-[520px] px-2 py-4" />
    </div>
  )
}

/** インストールコマンド (`pnpm dlx shadcn@latest add @acme/x`) を色分けする */
export function CommandLine({ command }: { command: string }) {
  const parts = command.split(" ")
  return (
    <span className="font-mono text-[13px] text-zinc-300">
      {parts.map((p, i) => {
        const color =
          i === 0 || p === "dlx" || p === "--bun"
            ? "text-fuchsia-300"
            : p.startsWith("shadcn")
              ? "text-lime-200"
              : p === "add"
                ? "text-zinc-300"
                : "text-sky-300"
        return (
          <React.Fragment key={`${p}-${i}`}>
            {i > 0 && " "}
            <span className={color}>{p}</span>
          </React.Fragment>
        )
      })}
    </span>
  )
}

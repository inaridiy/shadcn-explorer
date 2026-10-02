import { Effect, Layer } from "effect"
import { DocsError, DocsReader } from "@shadcn-explorer/core/ports"

/**
 * ドキュメントの読み取り: webforai platform の内部向け RPC (Service Binding `WEBFORAI` → `PlatformRpc`)。
 * テーマのエージェントに渡すインストール手順のページを Markdown にし、ホームページのリンク一覧を取る。
 * 課金・API キーなし (tenant ごとに 300 回/分)。SSRF 対策は platform 側にある。
 * 失敗は "code: message" 形式の Error で届く (invalid_url / rate_limited / fetch_failed など)。
 */

const TENANT = "shadcn-explorer"

export interface PlatformRpc {
  convert(
    url: string,
    options: {
      readonly tenant: string
      readonly formats?: ReadonlyArray<"markdown" | "links">
      readonly extractor?: "auto" | "takumi" | "minimal" | "none"
      readonly engine?: "auto" | "fetch" | "browser"
    },
  ): Promise<{
    /** リダイレクト後の最終 URL */
    readonly url: string
    /** formats に markdown が無ければ空文字 */
    readonly markdown: string
    /** ページ内の http(s) リンク (他オリジンも含む。同じサイトかどうかは呼び出し側で絞る) */
    readonly links?: ReadonlyArray<string>
    readonly engine: string
    readonly warning?: string
  }>
}

export const WebforaiDocsReader = (rpc: PlatformRpc) => {
  const convert = (url: string, formats: ReadonlyArray<"markdown" | "links">) =>
    Effect.tryPromise({
      // タブの中のコードブロック (pnpm / npm …) を落とさないよう、本文の抽出はしない
      try: () => rpc.convert(url, { tenant: TENANT, formats, extractor: "none" }),
      catch: (e) => new DocsError({ url, reason: String(e instanceof Error ? e.message : e).slice(0, 300) }),
    })
  return Layer.succeed(DocsReader, {
    name: "webforai",
    links: (url) => Effect.map(convert(url, ["links"]), (page) => page.links ?? []),
    read: (url) => Effect.map(convert(url, ["markdown"]), (page) => ({ url: page.url || url, markdown: page.markdown })),
  })
}

/** ドキュメントを読まない (ローカルのフェイク構成。テーマのエージェントも回さない) */
export const NoDocsReader = Layer.succeed(DocsReader, {
  name: "none",
  links: (url) => Effect.fail(new DocsError({ url, reason: "docs reader is not configured" })),
  read: (url) => Effect.fail(new DocsError({ url, reason: "docs reader is not configured" })),
})

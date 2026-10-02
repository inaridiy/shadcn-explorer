import { Data, Either, Schema } from "effect"

/**
 * ユーザーが「レジストリ登録」フォームに入力する値の解釈。
 *
 * shadcn レジストリは慣習として
 *   - インデックス:  https://example.com/r/registry.json
 *   - アイテム:      https://example.com/r/{name}.json
 * という URL 構成を取る。ユーザーはそのどれを貼ってくるか分からないので、
 * 入力を ADT に分類してから「試すべきロケータ候補」を純粋関数で導出する。
 */
export type RegistryInput = Data.TaggedEnum<{
  /** `.../registry.json` を直接指定 */
  IndexUrl: { readonly url: URL }
  /** `components.json` の registries に書く `https://x/r/{name}.json` 形式 */
  ItemTemplate: { readonly template: string }
  /** `@acme` のような名前空間 (shadcn 公式ディレクトリで解決する) */
  Namespace: { readonly namespace: string }
  /** 単一アイテムの URL (`.../r/button.json`) */
  ItemUrl: { readonly url: URL }
  /** サイトのトップなど、それ以外の URL */
  SiteUrl: { readonly url: URL }
}>
export const RegistryInput = Data.taggedEnum<RegistryInput>()

/** 解決済みのレジストリの所在。インデックス URL とアイテム URL テンプレートの組。 */
export class RegistryLocator extends Schema.Class<RegistryLocator>("RegistryLocator")({
  indexUrl: Schema.String,
  itemUrlTemplate: Schema.String.pipe(Schema.includes("{name}")),
}) {
  itemUrl(name: string): string {
    return this.itemUrlTemplate.replaceAll("{name}", encodeURIComponent(name))
  }
}

export class InvalidRegistryInput extends Data.TaggedError("InvalidRegistryInput")<{
  readonly input: string
  readonly reason: string
}> {}

const NAMESPACE_RE = /^@[a-z0-9][a-z0-9-_]*$/i

const isPrivateHost = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true
  // IP リテラルは一律拒否する (SSRF 対策 & レジストリは通常ドメインで公開される)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true
  if (h.includes(":")) return true
  return false
}

/**
 * 外部から取得してよい URL かを検証する。Workers からは内部ネットワークに届かないが、
 * 多層防御としてドメインでも弾く。
 */
export const parsePublicHttpsUrl = (raw: string): Either.Either<URL, InvalidRegistryInput> => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return Either.left(new InvalidRegistryInput({ input: raw, reason: "URL として解釈できません" }))
  }
  if (url.protocol !== "https:") {
    return Either.left(new InvalidRegistryInput({ input: raw, reason: "https の URL のみ登録できます" }))
  }
  if (url.username || url.password) {
    return Either.left(new InvalidRegistryInput({ input: raw, reason: "認証情報付き URL は登録できません" }))
  }
  if (isPrivateHost(url.hostname)) {
    return Either.left(new InvalidRegistryInput({ input: raw, reason: "公開ドメインの URL を指定してください" }))
  }
  return Either.right(url)
}

/** 入力文字列を RegistryInput に分類する */
export const classifyRegistryInput = (rawInput: string): Either.Either<RegistryInput, InvalidRegistryInput> => {
  const input = rawInput.trim()
  if (input.length === 0) {
    return Either.left(new InvalidRegistryInput({ input, reason: "URL か @namespace を入力してください" }))
  }
  if (NAMESPACE_RE.test(input)) {
    return Either.right(RegistryInput.Namespace({ namespace: input.toLowerCase() }))
  }
  // {name} はそのままだと URL パーサがエンコードしてしまうので退避して検証する
  if (input.includes("{name}")) {
    return parsePublicHttpsUrl(input.replaceAll("{name}", "__name__").replaceAll("{style}", "__style__")).pipe(
      Either.map(() => RegistryInput.ItemTemplate({ template: input })),
    )
  }
  return parsePublicHttpsUrl(input).pipe(
    Either.map((url) => {
      const last = url.pathname.split("/").pop() ?? ""
      if (last === "registry.json") return RegistryInput.IndexUrl({ url })
      if (last.endsWith(".json")) return RegistryInput.ItemUrl({ url })
      return RegistryInput.SiteUrl({ url })
    }),
  )
}

const stripSearch = (url: URL): URL => {
  const u = new URL(url.toString())
  u.search = ""
  u.hash = ""
  return u
}

const locatorFromIndex = (indexUrl: URL): RegistryLocator => {
  const u = stripSearch(indexUrl)
  const base = u.toString().replace(/registry\.json$/, "")
  return new RegistryLocator({ indexUrl: u.toString(), itemUrlTemplate: `${base}{name}.json` })
}

const locatorFromDirectory = (dir: URL): RegistryLocator => {
  const u = stripSearch(dir)
  const base = u.toString().endsWith("/") ? u.toString() : `${u.toString()}/`
  return new RegistryLocator({ indexUrl: `${base}registry.json`, itemUrlTemplate: `${base}{name}.json` })
}

/**
 * 入力から、順に試すべきロケータ候補を導出する (純粋関数)。
 * Namespace は外部ディレクトリの解決が必要なので空配列を返し、アプリケーション層で扱う。
 */
/**
 * `{style}` 入りのテンプレート (例: `https://diceui.com/r/{style}/{name}.json`)。shadcn の CLI は components.json の style で
 * 埋めるが、どの style で配信しているかはレジストリ次第なので、よく使われるものを順に試す (v0.7。公式ディレクトリの 8 件)
 */
export const REGISTRY_STYLES = ["new-york-v4", "radix-vega", "base-vega", "radix-nova", "base-nova", "new-york", "default"] as const
const expandStyle = (template: string): ReadonlyArray<string> =>
  template.includes("{style}") ? REGISTRY_STYLES.map((style) => template.replaceAll("{style}", style)) : [template]

export const candidateLocators = (input: RegistryInput): ReadonlyArray<RegistryLocator> =>
  RegistryInput.$match(input, {
    IndexUrl: ({ url }) => [locatorFromIndex(url)],
    ItemTemplate: ({ template }) =>
      expandStyle(template).map(
        (t) =>
          new RegistryLocator({
            indexUrl: t.replace(/\{name\}(\.json)?$/, "registry.json").replaceAll("{name}", "registry"),
            itemUrlTemplate: t,
          }),
      ),
    Namespace: () => [],
    ItemUrl: ({ url }) => [locatorFromDirectory(new URL(".", stripSearch(url)))],
    SiteUrl: ({ url }) => {
      const origin = url.origin
      const path = url.pathname.replace(/\/+$/, "")
      const dirs = [
        path.length > 0 ? `${origin}${path}/` : null,
        path.length > 0 ? `${origin}${path}/r/` : null,
        `${origin}/r/`,
        `${origin}/`,
      ].filter((d): d is string => d !== null)
      return [...new Set(dirs)].map((d) => locatorFromDirectory(new URL(d)))
    },
  })

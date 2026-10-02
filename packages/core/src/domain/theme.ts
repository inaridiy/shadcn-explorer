import { Schema } from "effect"
import { canonicalJson } from "./component.js"
import type { WireRegistryItem } from "./registry-wire.js"

/**
 * レジストリのテーマ (v0.6)。
 *
 * テーマの正は「ユーザーがインストール手順どおりに入れたら得るもの」。ドキュメントサイトの見た目 (ライブ CSS) ではない。
 *   1. registry.json の registry:style / registry:base / registry:theme アイテム (= `shadcn init @ns` が入れるもの) を
 *      決定的に検出する (detectThemeFromItems)
 *   2. それで決まらないレジストリだけ、フォールバックの Coding Agent がインストール手順を読んで提案する (validateThemeProposal)
 *
 * 設定は 2 種類に分かれる:
 *   - ビルド時 (baseItems / themeVars / fonts / css / 手書きの themeCss / pins): 変えるとビルドし直す (デモは再利用)
 *   - 実行時 (tokens / variants): CSS 変数の「値」だけ。ビルド済み HTML に注入できるので、変えても撮り直しだけで済む。
 *     閲覧者がコンポーネントのページでテーマを切り替えるのにも使う
 * トークンは自由文の CSS ではなく「名前 → 値」のデータとして持ち、文法で無害化する (ハーネスの theme-tokens.mjs と同じ規則)。
 */

// ---------------------------------------------------------------------------
// トークン (CSS 変数) の文法
// ---------------------------------------------------------------------------

/** --background、--color-main など。Tailwind の内部変数 (--tw-*) は扱わない */
const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,48}$/
/** 色・長さ・calc()/var()・フォント名・影に使う文字だけ。"<" ";" "{" "}" "\" "@" は通さない */
const TOKEN_VALUE = /^[A-Za-z0-9 #%.,()\-+*/'"_!]{1,300}$/
/** 外部参照になる関数は値に書かせない (配信時の CSP でも外部通信は止まるが、データの段階で落とす) */
const FORBIDDEN_FUNCTION = /\b(url|image|image-set|src|expression|attr|env|element|paint)\s*\(/i
/** @theme に出す名前 (ユーティリティの名前空間) */
const THEME_VAR_NAME = /^--(color|font|shadow|inset-shadow|drop-shadow|radius|spacing|text|tracking|leading|animate|ease|blur)-[a-z0-9-]{1,40}$/
const FONT_FAMILY = /^[A-Za-z0-9 ]{1,60}$/

export const MAX_TOKENS = 200
export const MAX_VARIANTS = 8
export const MAX_FONTS = 4
export const MAX_CSS = 50_000

export const isValidTokenName = (name: string): boolean => TOKEN_NAME.test(name) && !name.startsWith("--tw-")
export const isValidTokenValue = (value: string): boolean => TOKEN_VALUE.test(value) && !FORBIDDEN_FUNCTION.test(value)

export const TokenMap = Schema.Record({ key: Schema.String, value: Schema.String })
export type TokenMap = typeof TokenMap.Type

/** 実行時に差し替えられるテーマ。dark が無いテーマは light だけで撮り、閲覧時もライトに固定する */
export const ThemeTokens = Schema.Struct({
  light: TokenMap,
  dark: Schema.optional(TokenMap),
})
export type ThemeTokens = typeof ThemeTokens.Type

/** 同じレジストリが配る別のテーマ (neobrutalism の blue / red など)。閲覧者が切り替えられる */
export const ThemeVariant = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(60)),
  tokens: ThemeTokens,
})
export type ThemeVariant = typeof ThemeVariant.Type

const tokenProblems = (map: TokenMap, label: string): Array<string> => {
  const problems: Array<string> = []
  const entries = Object.entries(map)
  if (entries.length > MAX_TOKENS) problems.push(`${label}: at most ${MAX_TOKENS} tokens`)
  for (const [name, value] of entries) {
    if (!isValidTokenName(name)) problems.push(`${label}: invalid token name ${JSON.stringify(name).slice(0, 60)}`)
    else if (!isValidTokenValue(value)) problems.push(`${label}: invalid value for ${name}`)
  }
  return problems
}

export const themeTokensProblems = (tokens: ThemeTokens, label = "tokens"): ReadonlyArray<string> => [
  ...tokenProblems(tokens.light, `${label}.light`),
  ...(tokens.dark ? tokenProblems(tokens.dark, `${label}.dark`) : []),
]

/** dark を持たないテーマ (ダークは撮らず、閲覧時もライトに固定する) */
export const isLightOnly = (tokens: ThemeTokens | undefined): boolean =>
  tokens !== undefined && Object.keys(tokens.light).length > 0 && (tokens.dark === undefined || Object.keys(tokens.dark).length === 0)

/**
 * registry-item.json の cssVars ({ light: { background: "…" }, dark: {…}, theme: {…} }) をトークンにする。
 * theme (Tailwind の @theme) はビルド時の設定なのでここでは扱わない (アイテムを baseItems で入れれば shadcn が書く)。
 * 文法に合わない値は落とす。light も dark も空なら null。
 */
export const tokensFromCssVars = (cssVars: unknown): ThemeTokens | null => {
  if (cssVars === null || typeof cssVars !== "object") return null
  const pick = (block: unknown): Record<string, string> => {
    if (block === null || typeof block !== "object") return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (typeof value !== "string") continue
      const name = key.startsWith("--") ? key : `--${key}`
      if (isValidTokenName(name) && isValidTokenValue(value.trim())) out[name] = value.trim()
    }
    return out
  }
  const { light, dark } = cssVars as { light?: unknown; dark?: unknown }
  const l = pick(light)
  const d = pick(dark)
  if (Object.keys(l).length === 0 && Object.keys(d).length === 0) return null
  return Object.keys(d).length > 0 ? { light: l, dark: d } : { light: l }
}

// ---------------------------------------------------------------------------
// ハッシュ (プレビューの鮮度判定に使う。暗号学的な強さは要らない)
// ---------------------------------------------------------------------------

/** cyrb53。planEnrichment (同期の純粋関数) から使うので同期で計算する */
export const stableHash = (input: string): string => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0")
}

// ---------------------------------------------------------------------------
// 提案 (検出・エージェントの出力) と、レジストリのテーマの状態
// ---------------------------------------------------------------------------

/** ビルド時・実行時のテーマ設定 (RegistryPreviewConfig のうちテーマに関わる部分。提案もこの形で持つ) */
export const ThemeConfig = Schema.Struct({
  /** 全アイテムの前に `shadcn add` するアイテム (`@ns/name` か https の item URL) */
  baseItems: Schema.optional(Schema.Array(Schema.String).pipe(Schema.maxItems(10))),
  /** @theme inline に出す名前 (`--color-main: var(--main)`)。`bg-main` などのユーティリティを生成させる */
  themeVars: Schema.optional(TokenMap),
  /** Google Fonts のファミリー名。ハーネスが @import を組み立て、ビルド時に埋め込む */
  fonts: Schema.optional(Schema.Array(Schema.String).pipe(Schema.maxItems(MAX_FONTS))),
  /** トークンで表せない CSS (@layer base など)。@import と url() は不可 */
  css: Schema.optional(Schema.String.pipe(Schema.maxLength(MAX_CSS))),
  tokens: Schema.optional(ThemeTokens),
  variants: Schema.optional(Schema.Array(ThemeVariant).pipe(Schema.maxItems(MAX_VARIANTS))),
})
export type ThemeConfig = typeof ThemeConfig.Type

export const ThemeEvidence = Schema.Struct({
  url: Schema.String.pipe(Schema.maxLength(500)),
  quote: Schema.String.pipe(Schema.maxLength(2000)),
})
export type ThemeEvidence = typeof ThemeEvidence.Type

export const ThemeConfidence = Schema.Literal("high", "medium", "low")
export type ThemeConfidence = typeof ThemeConfidence.Type

export const ThemeSource = Schema.Literal("registry-item", "agent", "manual", "none")
export type ThemeSource = typeof ThemeSource.Type

export const ThemeProposal = Schema.Struct({
  source: Schema.Literal("registry-item", "agent"),
  config: ThemeConfig,
  evidence: Schema.Array(ThemeEvidence),
  confidence: ThemeConfidence,
  notes: Schema.String.pipe(Schema.maxLength(4000)),
})
export type ThemeProposal = typeof ThemeProposal.Type

/**
 * レジストリのテーマの状態。inputHash は判定の入力 (registry.json のテーマ系アイテム) のハッシュで、
 * 変われば再判定する。ドキュメントの変化は追わない (手動の再判定ボタンで拾う)。
 *   Unresolved ─同期→ Resolved (registry.json で決まった / テーマなし)
 *              └────→ AgentPending ─エージェント→ Proposed ─承認→ Resolved (agent)
 *                                              └────→ Failed      └却下→ Resolved (none)
 * AgentPending の間は、そのレジストリのプレビューを作らない (テーマが決まる前に作ると作り直しになる)。
 */
export const RegistryTheme = Schema.Union(
  Schema.TaggedStruct("Unresolved", {}),
  Schema.TaggedStruct("AgentPending", { inputHash: Schema.String, startedAt: Schema.Number }),
  Schema.TaggedStruct("Proposed", { inputHash: Schema.String, proposal: ThemeProposal, proposedAt: Schema.Number }),
  Schema.TaggedStruct("Resolved", {
    inputHash: Schema.String,
    source: ThemeSource,
    note: Schema.String,
    resolvedAt: Schema.Number,
  }),
  Schema.TaggedStruct("Failed", { inputHash: Schema.String, reason: Schema.String, failedAt: Schema.Number }),
)
export type RegistryTheme = typeof RegistryTheme.Type

/** エージェントを待つ上限。Workflow が落ちても、これを過ぎればプレビューの保留は解ける */
export const THEME_HOLD_MS = 30 * 60_000

export const isPreviewOnHold = (theme: RegistryTheme, now: number): boolean =>
  theme._tag === "AgentPending" && now - theme.startedAt < THEME_HOLD_MS

// ---------------------------------------------------------------------------
// registry.json からの検出 (決定的)
// ---------------------------------------------------------------------------

const STYLE_TYPES = new Set(["registry:style", "registry:base", "registry:theme"])
const DEFAULT_NAMES = ["index", "base", "default", "style", "theme"]
/** これより多くテーマ系アイテムを持つレジストリは「テーマ集」で、そのレジストリのテーマというものが無い */
export const THEME_COLLECTION_THRESHOLD = 5

export interface ThemeCandidate {
  readonly item: WireRegistryItem
  /** `shadcn add` に渡す item URL */
  readonly url: string
}

export type ThemeDetection =
  /** テーマ系アイテムが無い。インストール手順を読む (エージェント) */
  | { readonly _tag: "NoCandidates"; readonly inputHash: string }
  /** テーマ集。neutral のまま */
  | { readonly _tag: "Collection"; readonly inputHash: string; readonly count: number }
  /** init が入れるスタイルはテーマを持たない (cssVars も css も空) = neutral が正 */
  | { readonly _tag: "Neutral"; readonly inputHash: string; readonly item: string }
  /** 適用する設定。auto = 候補が 1 つに決まったので承認なしで適用してよい */
  | { readonly _tag: "Detected"; readonly inputHash: string; readonly proposal: ThemeProposal; readonly auto: boolean }

const hasContent = (value: unknown) =>
  value !== null && typeof value === "object" && Object.values(value as Record<string, unknown>).some((v) => v !== null && typeof v === "object" && Object.keys(v).length > 0)

/** 判定の入力のハッシュ (テーマ系アイテムの内容)。変わったら再判定する */
export const themeInputHash = (candidates: ReadonlyArray<ThemeCandidate>): string =>
  stableHash(canonicalJson([...candidates].map((c) => c.item).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))))

/**
 * registry.json のテーマ系アイテムから、そのレジストリのテーマを決める。
 * - 0 個: NoCandidates (インストール手順を読む)
 * - THEME_COLLECTION_THRESHOLD 個超: テーマ集 (neutral)
 * - 既定の名前 (index / base / …) のアイテムが 1 つ、または候補が 1 つ: それを baseItems に入れる。auto
 *   その中身が空 (magicui の index のように init しても何も変わらない) なら Neutral
 * - 既定が決まらない複数候補: 先頭を既定にした提案 (運営者が選ぶ)
 * 候補それぞれの cssVars は variants (閲覧者が切り替えられるテーマ) にする。
 */
export const detectThemeFromItems = (candidates: ReadonlyArray<ThemeCandidate>): ThemeDetection => {
  const styles = candidates.filter((c) => STYLE_TYPES.has(c.item.type))
  const inputHash = themeInputHash(styles)
  if (styles.length === 0) return { _tag: "NoCandidates", inputHash }
  if (styles.length > THEME_COLLECTION_THRESHOLD) return { _tag: "Collection", inputHash, count: styles.length }

  const named = DEFAULT_NAMES.flatMap((n) => styles.filter((c) => c.item.name === n)).slice(0, 1)
  const chosen = named[0] ?? (styles.length === 1 ? styles[0]! : null)
  const primary = chosen ?? styles[0]!
  if (chosen && !hasContent(chosen.item.cssVars) && !hasContent(chosen.item.css)) {
    return { _tag: "Neutral", inputHash, item: chosen.item.name }
  }

  const tokens = tokensFromCssVars(primary.item.cssVars)
  const variants = styles.flatMap((c) => {
    const t = tokensFromCssVars(c.item.cssVars)
    return t ? [{ name: c.item.title ?? c.item.name, tokens: t }] : []
  })
  const proposal: ThemeProposal = {
    source: "registry-item",
    config: {
      baseItems: [primary.url],
      ...(tokens ? { tokens } : {}),
      ...(variants.length > 1 ? { variants: variants.slice(0, MAX_VARIANTS) } : {}),
    },
    evidence: [{ url: primary.url, quote: `${primary.item.type} "${primary.item.name}" in registry.json` }],
    confidence: chosen ? "high" : "medium",
    notes: chosen
      ? `registry.json の ${primary.item.type} "${primary.item.name}" (このレジストリのテーマ) を全アイテムの前に入れる`
      : `テーマ系アイテムが ${styles.length} 個あり既定が決まらないため、先頭の "${primary.item.name}" を既定にした。運営者が選ぶ`,
  }
  return { _tag: "Detected", inputHash, proposal, auto: chosen !== null }
}

// ---------------------------------------------------------------------------
// 提案の検証 (エージェントの出力は信頼できない)
// ---------------------------------------------------------------------------

const ITEM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|https:\/\/[^\s"'`]{1,300}\.json)$/


/**
 * 多くの人が同じホストで配信している場所。ホストが同じでも他人のものなので、オーナー/リポジトリ (パスの先頭 2 段) まで一致させる
 */
const SHARED_HOSTS = new Set(["raw.githubusercontent.com", "gist.githubusercontent.com", "github.com", "cdn.jsdelivr.net", "unpkg.com"])

/** www. の有無を同一視し、サブドメインも許す (docs.acme.dev と acme.dev) */
const sameSite = (host: string, allowed: string): boolean => {
  const strip = (h: string) => h.replace(/^www\./, "")
  const a = strip(host)
  const b = strip(allowed)
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export const cssProblems = (css: string): ReadonlyArray<string> => {
  const problems: Array<string> = []
  if (css.length > MAX_CSS) problems.push(`css: at most ${MAX_CSS} characters`)
  if (/@import/i.test(css)) problems.push("css: @import is not allowed (use fonts)")
  if (FORBIDDEN_FUNCTION.test(css)) problems.push("css: url()/image() and other external references are not allowed")
  if (/<\/?\s*style|<\s*script/i.test(css)) problems.push("css: must not contain HTML")
  return problems
}

/**
 * テーマ設定の検査。空配列 = 合格。
 * scope があれば (= エージェントの提案)、baseItems はレジストリ自身の配信元 (registryUrls) か、レジストリ自身の名前空間に限り
 * (ドキュメントに書かれた他人の URL を実行する経路を塞ぐ)、コントラストも確かめる。
 * null (= 運営者の手入力) は、ハーネスに渡る文法だけ検査する。
 */
/** spec (アイテムの URL) が、レジストリ自身の URL (ホームページ・registry.json・アイテム URL) と同じ配信元か */
export const isRegistryOwnedUrl = (spec: string, registryUrls: ReadonlyArray<string>): boolean => {
  let url: URL
  try {
    url = new URL(spec)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  const head = (u: URL) => u.pathname.split("/").filter(Boolean).slice(0, 2).join("/")
  return registryUrls.some((raw) => {
    let allowed: URL
    try {
      allowed = new URL(raw)
    } catch {
      return false
    }
    if (SHARED_HOSTS.has(host)) return host === allowed.hostname.toLowerCase() && head(url) !== "" && head(url) === head(allowed)
    return sameSite(host, allowed.hostname.toLowerCase())
  })
}

export const validateThemeConfig = (
  config: ThemeConfig,
  /** registryUrls: レジストリ自身の URL (ホームページ・registry.json・アイテム URL のテンプレート) */
  scope: { readonly registryUrls: ReadonlyArray<string>; readonly namespace: string | null } | null,
): ReadonlyArray<string> => {
  const problems: Array<string> = []
  for (const spec of config.baseItems ?? []) {
    if (!ITEM_SPEC.test(spec)) {
      problems.push(`baseItems: invalid spec ${JSON.stringify(spec).slice(0, 80)}`)
      continue
    }
    if (scope === null) continue
    if (spec.startsWith("@")) {
      if (scope.namespace === null || !spec.startsWith(`${scope.namespace}/`)) {
        problems.push(`baseItems: ${spec} is not in the registry's own namespace`)
      }
    } else {
      if (!isRegistryOwnedUrl(spec, scope.registryUrls)) problems.push(`baseItems: ${spec} is not hosted by the registry`)
    }
  }
  if (scope !== null && (config.baseItems ?? []).length > 3) problems.push("baseItems: at most 3 items")
  if (config.tokens) problems.push(...themeTokensProblems(config.tokens))
  for (const [i, v] of (config.variants ?? []).entries()) problems.push(...themeTokensProblems(v.tokens, `variants[${i}]`))
  for (const [name, value] of Object.entries(config.themeVars ?? {})) {
    if (!THEME_VAR_NAME.test(name)) problems.push(`themeVars: invalid name ${JSON.stringify(name).slice(0, 60)}`)
    else if (!isValidTokenValue(value)) problems.push(`themeVars: invalid value for ${name}`)
  }
  if ((config.fonts ?? []).length > MAX_FONTS) problems.push(`fonts: at most ${MAX_FONTS} families`)
  if ((config.variants ?? []).length > MAX_VARIANTS) problems.push(`variants: at most ${MAX_VARIANTS} themes`)
  if (Object.keys(config.themeVars ?? {}).length > MAX_TOKENS) problems.push(`themeVars: at most ${MAX_TOKENS} names`)
  for (const font of config.fonts ?? []) if (!FONT_FAMILY.test(font)) problems.push(`fonts: invalid family ${JSON.stringify(font).slice(0, 60)}`)
  if (config.css !== undefined) problems.push(...cssProblems(config.css))
  if (scope !== null) problems.push(...contrastProblems(config.tokens))
  return problems
}

// ---------------------------------------------------------------------------
// コントラスト (light / dark の取り違えや、サイト側のトークンの誤採用を落とす)
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const num = (s: string) => {
  const v = Number.parseFloat(s)
  return s.trim().endsWith("%") ? v / 100 : v
}

const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

/** oklch → linear sRGB → sRGB (Björn Ottosson の行列) */
const oklchToRgb = (L: number, C: number, H: number): Rgb => {
  const hr = (H * Math.PI) / 180
  const a = C * Math.cos(hr)
  const b = C * Math.sin(hr)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  return [clamp01(gamma(lin[0])), clamp01(gamma(lin[1])), clamp01(gamma(lin[2]))]
}

/** 対応する色の書式だけ解釈する (hex / rgb() / hsl() / oklch() / shadcn v3 の "h s% l%")。それ以外は null (検査しない) */
export const parseColor = (value: string): Rgb | null => {
  const v = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!
    return [Number.parseInt(h.slice(0, 2), 16) / 255, Number.parseInt(h.slice(2, 4), 16) / 255, Number.parseInt(h.slice(4, 6), 16) / 255]
  }
  const fn = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(v)
  const parts = (fn ? fn[2]! : v).split(/[\s,/]+/).filter(Boolean)
  if (fn?.[1]?.startsWith("rgb") && parts.length >= 3) {
    return [0, 1, 2].map((i) => (parts[i]!.endsWith("%") ? num(parts[i]!) : num(parts[i]!) / 255)).map(clamp01) as unknown as Rgb
  }
  if (fn?.[1] === "oklch" && parts.length >= 3) {
    const L = parts[0]!.endsWith("%") ? num(parts[0]!) : num(parts[0]!)
    return oklchToRgb(L, num(parts[1]!), Number.parseFloat(parts[2]!) || 0)
  }
  if ((fn?.[1]?.startsWith("hsl") || (!fn && /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/.test(v))) && parts.length >= 3) {
    return hslToRgb(Number.parseFloat(parts[0]!), clamp01(num(parts[1]!)), clamp01(num(parts[2]!)))
  }
  return null
}

const luminance = ([r, g, b]: Rgb) => {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** --background と --foreground のコントラストが 3 未満なら問題 (どちらかが解釈できなければ検査しない) */
export const contrastProblems = (tokens: ThemeTokens | undefined): ReadonlyArray<string> => {
  if (!tokens) return []
  const check = (map: TokenMap | undefined, label: string) => {
    const bg = map?.["--background"] ? parseColor(map["--background"]) : null
    const fg = map?.["--foreground"] ? parseColor(map["--foreground"]) : null
    if (!bg || !fg) return []
    const ratio = contrastRatio(bg, fg)
    return ratio < 3 ? [`${label}: --foreground on --background has contrast ${ratio.toFixed(2)} (< 3)`] : []
  }
  return [...check(tokens.light, "tokens.light"), ...check(tokens.dark, "tokens.dark")]
}

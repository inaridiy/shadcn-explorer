import neutralCss from "../../preview-harness/src/theme-default.css?raw"

/** ハーネスと同じ形のトークン (CSS 変数の名前 → 値)。クライアントでも使うので core に依存しない */
export interface ThemeTokensDto {
  readonly light: Readonly<Record<string, string>>
  readonly dark?: Readonly<Record<string, string>> | undefined
}

const parseBlock = (css: string, selector: string): Record<string, string> => {
  const body = new RegExp(`(^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? ""
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()] as const),
  )
}

/** ハーネスの既定 (shadcn neutral)。閲覧者が「Neutral」を選んだときに注入する */
export const NEUTRAL_TOKENS: ThemeTokensDto = { light: parseBlock(neutralCss, ":root"), dark: parseBlock(neutralCss, ".dark") }

export const isLightOnly = (tokens: ThemeTokensDto | null | undefined) =>
  tokens != null && Object.keys(tokens.light).length > 0 && (!tokens.dark || Object.keys(tokens.dark).length === 0)

/** 見本に出す色のトークン (あるものだけ) */
export const SWATCH_TOKENS = ["--background", "--foreground", "--primary", "--secondary", "--accent", "--main", "--border"] as const

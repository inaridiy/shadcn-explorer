export type TokenMap = Readonly<Record<string, string>>
export interface ThemeTokens {
  readonly light: TokenMap
  readonly dark?: TokenMap
}
export declare const sanitizeTokenMap: (map: unknown) => Record<string, string>
export declare const tokensCss: (tokens: unknown) => string
export declare const themeVarsCss: (vars: unknown) => string
export declare const fontImports: (fonts: unknown) => Array<string>
export declare const isAllowedCss: (css: unknown) => boolean

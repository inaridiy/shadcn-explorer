/**
 * Registry theme tokens (trusted code; the token data is not — it may come from the fallback agent's proposal).
 * Shared by main.tsx (runtime switching via postMessage), render.mjs (injection before a capture) and run-job.mjs (baked
 * into the build). The rules mirror packages/core/src/domain/theme.ts: tokens are data ("--name" → value), never free CSS,
 * so a value cannot open a rule, reference a URL or close the <style> element.
 */
const TOKEN_NAME = /^--[a-z][a-z0-9-]{0,48}$/
const TOKEN_VALUE = /^[A-Za-z0-9 #%.,()\-+*/'"_!]{1,300}$/
const FORBIDDEN_FUNCTION = /\b(url|image|image-set|src|expression|attr|env|element|paint)\s*\(/i
const THEME_VAR_NAME = /^--(color|font|shadow|inset-shadow|drop-shadow|radius|spacing|text|tracking|leading|animate|ease|blur)-[a-z0-9-]{1,40}$/
const FONT_FAMILY = /^[A-Za-z0-9 ]{1,60}$/
const MAX_TOKENS = 200

const isValue = (v) => typeof v === "string" && TOKEN_VALUE.test(v) && !FORBIDDEN_FUNCTION.test(v)

/** Keeps only valid "--name: value" pairs */
export const sanitizeTokenMap = (map) => {
  if (map === null || typeof map !== "object") return {}
  const out = {}
  for (const [name, value] of Object.entries(map).slice(0, MAX_TOKENS)) {
    if (TOKEN_NAME.test(name) && !name.startsWith("--tw-") && isValue(value)) out[name] = value
  }
  return out
}

const block = (selector, map) => {
  const entries = Object.entries(map)
  return entries.length === 0 ? "" : `${selector} {\n${entries.map(([n, v]) => `  ${n}: ${v};`).join("\n")}\n}\n`
}

/**
 * Tokens → CSS. `:root.dark` (higher specificity than the harness's `.dark`) makes an injected dark block win; a theme
 * without a dark block is light-only (the caller forces the light scheme).
 */
export const tokensCss = (tokens) => {
  if (tokens === null || typeof tokens !== "object") return ""
  return block(":root", sanitizeTokenMap(tokens.light)) + block(":root.dark", sanitizeTokenMap(tokens.dark))
}

/** Build-time names for Tailwind utilities (`--color-main: var(--main)` → `bg-main`) */
export const themeVarsCss = (vars) => {
  if (vars === null || typeof vars !== "object") return ""
  const entries = Object.entries(vars).filter(([n, v]) => THEME_VAR_NAME.test(n) && isValue(v)).slice(0, MAX_TOKENS)
  return entries.length === 0 ? "" : `@theme inline {\n${entries.map(([n, v]) => `  ${n}: ${v};`).join("\n")}\n}\n`
}

/** Google Fonts imports for family names (inline-fonts.ts embeds them as data: URIs at build time) */
export const fontImports = (fonts) =>
  (Array.isArray(fonts) ? fonts : [])
    .filter((f) => typeof f === "string" && FONT_FAMILY.test(f))
    .slice(0, 4)
    .map((f) => `@import url("https://fonts.googleapis.com/css2?family=${f.trim().replace(/ +/g, "+")}&display=swap");`)

/** Extra CSS a theme needs beyond tokens (@layer base etc.). No imports, no external references, no HTML. */
export const isAllowedCss = (css) =>
  typeof css === "string" &&
  css.length <= 50_000 &&
  !/@import/i.test(css) &&
  !FORBIDDEN_FUNCTION.test(css) &&
  !/<\/?\s*style|<\s*script/i.test(css)

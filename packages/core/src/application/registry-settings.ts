import { Clock, Effect, Option } from "effect"
import {
  type RegistryId,
  type RegistryPreviewConfig,
  type RegistryTheme,
  validateThemeConfig,
} from "../domain/index.js"
import { RegistryRepository } from "../ports/index.js"
import { RegistryNotFoundById } from "./errors.js"
import { InvalidThemeConfig, applyPreviewConfig } from "./registry-theme.js"

const THEME_FIELDS = ["baseItems", "themeVars", "fonts", "css", "tokens", "variants", "themeCss"] as const

const nonEmpty = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  !(typeof value === "string" && value.trim() === "") &&
  !(Array.isArray(value) && value.length === 0) &&
  !(typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)

/**
 * レジストリのプレビュー設定 (テーマ・ベースアイテム・依存の固定) を更新する。誰に許すか (現在は運営者のみ) は呼び出し側が決める。
 * 何を作り直すかは planEnrichment が設定のハッシュで決める (ビルド設定ならビルドし直し、トークンだけなら撮り直し。
 * どちらもデモは書き直さない)。テーマに関わる項目を手で変えたら、テーマの状態を「手動」にする
 * (registry.json が変わっても自動では上書きせず、提案に留める)。
 */
export const updateRegistryPreviewConfig = (registryId: RegistryId, config: RegistryPreviewConfig) =>
  Effect.gen(function* () {
    const registries = yield* RegistryRepository
    const found = yield* registries.findById(registryId)
    if (Option.isNone(found)) return yield* new RegistryNotFoundById({ registryId })
    const registry = found.value

    const normalized = Object.fromEntries(
      Object.entries({
        ...config,
        ...(config.baseItems ? { baseItems: config.baseItems.map((s) => s.trim()).filter(Boolean) } : {}),
      }).filter(([, v]) => nonEmpty(v)),
    ) as RegistryPreviewConfig
    // 運営者の入力なのでホストの制限はしないが、ハーネスに渡る文法は検査する
    const problems = validateThemeConfig(normalized, null)
    if (problems.length > 0) return yield* new InvalidThemeConfig({ problems })

    const themeChanged = THEME_FIELDS.some(
      (k) => JSON.stringify(normalized[k] ?? null) !== JSON.stringify(registry.previewConfig[k] ?? null),
    )
    const now = yield* Clock.currentTimeMillis
    const theme: RegistryTheme = themeChanged
      ? {
          _tag: "Resolved",
          inputHash: registry.theme._tag === "Unresolved" ? "" : registry.theme.inputHash,
          source: "manual",
          note: "運営者がプレビュー設定を編集した",
          resolvedAt: now,
        }
      : registry.theme
    const { rebuilding } = yield* applyPreviewConfig(registry, normalized, theme)
    return { rebuilding }
  })

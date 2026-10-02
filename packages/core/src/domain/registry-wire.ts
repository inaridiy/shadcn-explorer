import { Schema } from "effect"

/**
 * shadcn レジストリの「外部フォーマット」(registry.json / registry-item.json)。
 * https://ui.shadcn.com/schema/registry.json
 * https://ui.shadcn.com/schema/registry-item.json
 *
 * 腐敗防止層 (ACL) として、外部フォーマットはここでだけ扱い、
 * ドメインモデル (Component) へは `toComponentSnapshot` で変換する。
 * 外部入力なので未知のフィールドは無視し、必須フィールドは最小限にする。
 */

const OptionalString = Schema.optional(Schema.String)
const OptionalStringArray = Schema.optional(Schema.Array(Schema.String))

export const WireRegistryFile = Schema.Struct({
  path: Schema.String,
  type: OptionalString,
  target: OptionalString,
  content: OptionalString,
})
export type WireRegistryFile = typeof WireRegistryFile.Type

export const WireRegistryItem = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  title: OptionalString,
  description: OptionalString,
  author: OptionalString,
  docs: OptionalString,
  dependencies: OptionalStringArray,
  devDependencies: OptionalStringArray,
  registryDependencies: OptionalStringArray,
  categories: OptionalStringArray,
  files: Schema.optional(Schema.Array(WireRegistryFile)),
  cssVars: Schema.optional(Schema.Unknown),
  css: Schema.optional(Schema.Unknown),
  tailwind: Schema.optional(Schema.Unknown),
  meta: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
})
export type WireRegistryItem = typeof WireRegistryItem.Type

export const WireRegistryIndex = Schema.Struct({
  name: Schema.String,
  homepage: OptionalString,
  items: Schema.optionalWith(Schema.Array(WireRegistryItem), { default: () => [] }),
  /** 分割された registry.json への相対パス (shadcn 4.x) */
  include: OptionalStringArray,
})
export type WireRegistryIndex = typeof WireRegistryIndex.Type

/**
 * shadcn 公式のレジストリディレクトリ (https://ui.shadcn.com/r/registries.json)。
 * 形式が変わっても壊れにくいよう、配列形式とレコード形式の両方を受け付ける。
 */
export const WireDirectoryEntry = Schema.Struct({
  name: Schema.String,
  homepage: OptionalString,
  url: Schema.String,
  description: OptionalString,
  health: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      score: Schema.optional(Schema.Number),
      hidden: Schema.optional(Schema.Boolean),
    }),
  ),
  /** 公式ディレクトリの並び順の指標と、ディレクトリが数えたアイテム数 */
  ranking: Schema.optional(
    Schema.Struct({
      score: Schema.optional(Schema.Number),
      itemCount: Schema.optional(Schema.Number),
    }),
  ),
})
export type WireDirectoryEntry = typeof WireDirectoryEntry.Type

export const WireDirectory = Schema.Union(
  Schema.Array(WireDirectoryEntry),
  Schema.Record({ key: Schema.String, value: Schema.String }),
)
export type WireDirectory = typeof WireDirectory.Type

/**
 * shadcn/ui 自身はディレクトリに載っていない (index.json は配列で、registry.json の形式ではない)。
 * style ごとの registry.json (`/r/styles/{style}/registry.json`) は正規の形式なので、ディレクトリの項目として足して公式扱いにする
 */
export const SHADCN_UI_ENTRY: WireDirectoryEntry = {
  name: "@shadcn",
  homepage: "https://ui.shadcn.com",
  url: "https://ui.shadcn.com/r/styles/new-york-v4/{name}.json",
  description: "The components shadcn/ui itself ships (new-york-v4 style).",
}

export const normalizeDirectory = (dir: WireDirectory): ReadonlyArray<WireDirectoryEntry> => {
  const entries = Array.isArray(dir)
    ? (dir as ReadonlyArray<WireDirectoryEntry>)
    : Object.entries(dir as Record<string, string>).map(([name, url]) => ({ name, url }))
  return entries.some((e) => e.name.toLowerCase() === SHADCN_UI_ENTRY.name) ? entries : [SHADCN_UI_ENTRY, ...entries]
}

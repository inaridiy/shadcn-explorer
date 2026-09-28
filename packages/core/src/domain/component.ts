import { Data, Effect, Schema } from "effect"
import { ComponentId, ItemName, RegistryId, makeComponentId } from "./ids.js"
import type { WireRegistryItem } from "./registry-wire.js"

/**
 * レジストリアイテムの種別。shadcn の `registry:*` 型をドメインの語彙に写す。
 * 未知の型は Unknown として保持し、落とさない (レジストリ側の拡張に追従するため)。
 */
export const ComponentKind = Schema.Literal(
  "ui",
  "component",
  "block",
  "page",
  "hook",
  "lib",
  "theme",
  "style",
  "font",
  "file",
  "example",
  "item",
  "unknown",
)
export type ComponentKind = typeof ComponentKind.Type

const KIND_BY_WIRE: Record<string, ComponentKind> = {
  "registry:ui": "ui",
  "registry:component": "component",
  "registry:block": "block",
  "registry:page": "page",
  "registry:hook": "hook",
  "registry:lib": "lib",
  "registry:theme": "theme",
  "registry:style": "style",
  "registry:base": "style",
  "registry:font": "font",
  "registry:file": "file",
  "registry:example": "example",
  "registry:item": "item",
}

export const kindFromWire = (type: string): ComponentKind => KIND_BY_WIRE[type] ?? "unknown"

/**
 * 見た目のプレビューを撮る価値があるか。
 * hook / lib のような非ビジュアルなアイテムでブラウザ時間 (= コスト) を使わないための判定。
 */
export type Previewability = Data.TaggedEnum<{
  Visual: {}
  /** テーマ・スタイルは「適用例」を撮る */
  Themed: {}
  NonVisual: { readonly reason: string }
}>
export const Previewability = Data.taggedEnum<Previewability>()

export const previewabilityOf = (kind: ComponentKind): Previewability => {
  switch (kind) {
    case "ui":
    case "component":
    case "block":
    case "page":
    case "example":
    case "item":
      return Previewability.Visual()
    case "theme":
    case "style":
    case "font":
      return Previewability.Themed()
    case "hook":
    case "lib":
    case "file":
    case "unknown":
      return Previewability.NonVisual({ reason: `${kind} は視覚的な出力を持ちません` })
  }
}

export const ComponentFile = Schema.Struct({
  path: Schema.String,
  type: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
})
export type ComponentFile = typeof ComponentFile.Type

/**
 * レジストリから取得した「事実」のスナップショット。
 * AI で生成した情報 (ドキュメント・プレビュー) は Enrichment として別に持ち、
 * ソースが変わったかどうかは contentHash で判定する。
 */
export class ComponentSnapshot extends Schema.Class<ComponentSnapshot>("ComponentSnapshot")({
  id: ComponentId,
  registryId: RegistryId,
  name: ItemName,
  kind: ComponentKind,
  title: Schema.String,
  description: Schema.String,
  dependencies: Schema.Array(Schema.String),
  devDependencies: Schema.Array(Schema.String),
  registryDependencies: Schema.Array(Schema.String),
  categories: Schema.Array(Schema.String),
  files: Schema.Array(ComponentFile),
  sourceUrl: Schema.String,
  contentHash: Schema.String,
}) {}

export class InvalidRegistryItem extends Data.TaggedError("InvalidRegistryItem")<{
  readonly name: string
  readonly reason: string
}> {}

const titleize = (name: string): string =>
  name
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ")

/**
 * ソースの同一性を表すハッシュ。キー順に依存しないよう正規化してから SHA-256 を取る。
 * 変更がなければ AI 生成・スクショ・埋め込みを全てスキップできるため、コスト制御の要になる。
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export const sha256Hex = (input: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
  })

/** 外部フォーマット → ドメインモデルへの変換 (ACL) */
export const toComponentSnapshot = (
  registryId: RegistryId,
  item: WireRegistryItem,
  sourceUrl: string,
): Effect.Effect<ComponentSnapshot, InvalidRegistryItem> =>
  Effect.gen(function* () {
    const name = yield* Schema.decodeUnknown(ItemName)(item.name).pipe(
      Effect.mapError(() => new InvalidRegistryItem({ name: item.name, reason: "アイテム名が不正です" })),
    )
    const contentHash = yield* sha256Hex(canonicalJson(item))
    return new ComponentSnapshot({
      id: makeComponentId(registryId, name),
      registryId,
      name,
      kind: kindFromWire(item.type),
      title: item.title ?? titleize(item.name),
      description: item.description ?? "",
      dependencies: item.dependencies ?? [],
      devDependencies: item.devDependencies ?? [],
      registryDependencies: item.registryDependencies ?? [],
      categories: item.categories ?? [],
      files: (item.files ?? []).map((f) => ({
        path: f.path,
        ...(f.type !== undefined ? { type: f.type } : {}),
        ...(f.target !== undefined ? { target: f.target } : {}),
      })),
      sourceUrl,
      contentHash,
    })
  })

/**
 * インストールコマンド。名前空間付きレジストリなら `@ns/name`、なければ URL 指定。
 */
export const installCommand = (
  component: Pick<ComponentSnapshot, "name" | "sourceUrl">,
  namespace: string | null,
): string =>
  namespace !== null
    ? `npx shadcn@latest add ${namespace}/${component.name}`
    : `npx shadcn@latest add ${component.sourceUrl}`

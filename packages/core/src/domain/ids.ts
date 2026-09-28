import { Schema } from "effect"

/** レジストリ集約の識別子 */
export const RegistryId = Schema.String.pipe(Schema.minLength(1), Schema.brand("RegistryId"))
export type RegistryId = typeof RegistryId.Type

/**
 * コンポーネントの識別子。`${registryId}:${itemName}` で決定的に導出する。
 * 決定的にすることで再同期時の upsert が冪等になる。
 */
export const ComponentId = Schema.String.pipe(
  Schema.pattern(/^[^:]+:[^:]+$/),
  Schema.brand("ComponentId"),
)
export type ComponentId = typeof ComponentId.Type

export const UserId = Schema.String.pipe(Schema.minLength(1), Schema.brand("UserId"))
export type UserId = typeof UserId.Type

export const SyncRunId = Schema.String.pipe(Schema.minLength(1), Schema.brand("SyncRunId"))
export type SyncRunId = typeof SyncRunId.Type

/** レジストリ内のアイテム名 (kebab-case が慣習だが、外部入力なので緩めに許容) */
export const ItemName = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  Schema.maxLength(128),
  Schema.brand("ItemName"),
)
export type ItemName = typeof ItemName.Type

export const makeComponentId = (registryId: RegistryId, name: ItemName): ComponentId =>
  ComponentId.make(`${registryId}:${name}`)

/** レジストリ名から URL に載せる slug (= RegistryId) を作る */
export const slugifyRegistryName = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug.length > 0 ? slug : "registry"
}

import { Data, Either, Schema } from "effect"
import { RegistryId, UserId } from "./ids.js"
import { RegistryLocator } from "./registry-locator.js"

/** epoch millis */
export const Timestamp = Schema.Number.pipe(Schema.int(), Schema.nonNegative())
export type Timestamp = typeof Timestamp.Type

/**
 * レジストリのライフサイクル (直和型)。
 *
 *   Pending ──startSync──▶ Syncing ──complete──▶ Active ─┐
 *      ▲                     │                    │      │
 *      │                     └──fail──▶ Failed ◀──┘      │
 *      │                                  │  startSync   │ startSync
 *      └──────────── (Disabled は再有効化まで同期不可) ◀──┘
 */
export const RegistryStatus = Schema.Union(
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Syncing", {
    startedAt: Timestamp,
    lastSyncedAt: Schema.NullOr(Timestamp),
  }),
  Schema.TaggedStruct("Active", {
    lastSyncedAt: Timestamp,
    itemCount: Schema.Number,
  }),
  Schema.TaggedStruct("Failed", {
    failedAt: Timestamp,
    reason: Schema.String,
    lastSyncedAt: Schema.NullOr(Timestamp),
  }),
  Schema.TaggedStruct("Disabled", { reason: Schema.String }),
)
export type RegistryStatus = typeof RegistryStatus.Type

export class Registry extends Schema.Class<Registry>("Registry")({
  id: RegistryId,
  /** registry.json の name */
  name: Schema.String,
  homepage: Schema.NullOr(Schema.String),
  /** `@acme` のような名前空間。インストールコマンドの生成に使う */
  namespace: Schema.NullOr(Schema.String),
  locator: RegistryLocator,
  /** 登録者。公式ディレクトリからの自動取り込みは null */
  ownerId: Schema.NullOr(UserId),
  status: RegistryStatus,
  createdAt: Timestamp,
}) {}

export class IllegalRegistryTransition extends Data.TaggedError("IllegalRegistryTransition")<{
  readonly registryId: RegistryId
  readonly from: RegistryStatus["_tag"]
  readonly action: string
}> {}

const lastSyncedAtOf = (status: RegistryStatus): number | null => {
  switch (status._tag) {
    case "Active":
      return status.lastSyncedAt
    case "Syncing":
    case "Failed":
      return status.lastSyncedAt
    case "Pending":
    case "Disabled":
      return null
  }
}

const withStatus = (registry: Registry, status: RegistryStatus): Registry =>
  new Registry({ ...registry, status })

export const startSync = (registry: Registry, now: number): Either.Either<Registry, IllegalRegistryTransition> => {
  switch (registry.status._tag) {
    case "Pending":
    case "Active":
    case "Failed":
      return Either.right(
        withStatus(registry, { _tag: "Syncing", startedAt: now, lastSyncedAt: lastSyncedAtOf(registry.status) }),
      )
    case "Syncing":
    case "Disabled":
      return Either.left(
        new IllegalRegistryTransition({ registryId: registry.id, from: registry.status._tag, action: "startSync" }),
      )
  }
}

export const completeSync = (
  registry: Registry,
  now: number,
  itemCount: number,
): Either.Either<Registry, IllegalRegistryTransition> =>
  registry.status._tag === "Syncing"
    ? Either.right(withStatus(registry, { _tag: "Active", lastSyncedAt: now, itemCount }))
    : Either.left(
        new IllegalRegistryTransition({ registryId: registry.id, from: registry.status._tag, action: "completeSync" }),
      )

export const failSync = (
  registry: Registry,
  now: number,
  reason: string,
): Either.Either<Registry, IllegalRegistryTransition> =>
  registry.status._tag === "Syncing"
    ? Either.right(
        withStatus(registry, {
          _tag: "Failed",
          failedAt: now,
          reason,
          lastSyncedAt: registry.status.lastSyncedAt,
        }),
      )
    : Either.left(
        new IllegalRegistryTransition({ registryId: registry.id, from: registry.status._tag, action: "failSync" }),
      )

export const disable = (registry: Registry, reason: string): Registry =>
  withStatus(registry, { _tag: "Disabled", reason })

/**
 * 同期が「詰まっている」かの判定。Workflow が落ちて Syncing のまま残った場合に再開を許す。
 */
export const isStaleSync = (registry: Registry, now: number, timeoutMs: number): boolean =>
  registry.status._tag === "Syncing" && now - registry.status.startedAt > timeoutMs

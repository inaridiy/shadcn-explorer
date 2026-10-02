import { Data, Either, Schema } from "effect"
import { RegistryId, UserId } from "./ids.js"
import { RegistryLocator } from "./registry-locator.js"
import { RegistryTheme, ThemeConfig, isPreviewOnHold, stableHash } from "./theme.js"
import { canonicalJson } from "./component.js"
import { RegistryListing, operatorListing } from "./directory.js"

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

/**
 * レジストリ単位のプレビュー設定 (運営者が編集するデータ。テーマはエージェント・検出の提案を承認して入ることもある)。
 * コードに分岐を足す代わりにここへ書く。
 * ビルド時の設定 (変えるとビルドし直す。デモは再利用する):
 * - themeCss: 手書きの上書き CSS。レジストリがテーマを「globals.css に貼る」方式で、トークンで表せないときに使う
 * - baseItems / themeVars / fonts / css: テーマ (theme.ts の ThemeConfig)
 * - pins: 依存のバージョン固定 (pnpm overrides)。未指定の依存が最新メジャーに解決されて壊れる場合に使う
 * 実行時の設定 (変えても撮り直しだけ。閲覧者が切り替えられる):
 * - tokens / variants: CSS 変数の値
 */
export const RegistryPreviewConfig = Schema.Struct({
  themeCss: Schema.optional(Schema.String.pipe(Schema.maxLength(200_000))),
  pins: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  ...ThemeConfig.fields,
})
export type RegistryPreviewConfig = typeof RegistryPreviewConfig.Type

/** ビルドに効く設定のハッシュ。プレビューの Built / Captured が持ち、違えばビルドし直す */
export const buildConfigHash = (config: RegistryPreviewConfig): string => {
  const { tokens: _tokens, variants: _variants, ...build } = config
  return stableHash(canonicalJson(build))
}

/** 既定のトークンのハッシュ。違えば撮り直す (HTML が実行時の注入に対応していなければビルドし直す) */
export const tokensHash = (config: RegistryPreviewConfig): string => stableHash(canonicalJson(config.tokens ?? null))

/**
 * プレビューの計画に要るレジストリの情報。
 * onHold: テーマをエージェントが調べている間はプレビューを作らない (決まる前に作ると作り直しになる)
 */
export interface RegistryPreviewContext {
  readonly configHash: string
  readonly tokensHash: string
  readonly onHold: boolean
}

export const emptyPreviewContext: RegistryPreviewContext = {
  configHash: buildConfigHash({}),
  tokensHash: tokensHash({}),
  onHold: false,
}

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
  /** 登録時点の registry.json のアイテム数 (ユーザー別の月次クォータ計算に使う) */
  declaredItems: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  previewConfig: Schema.optionalWith(RegistryPreviewConfig, { default: () => ({}) }),
  /** テーマの判定状態 (registry.json の検出 → エージェント。確信度が低いものだけ提案に留める) */
  theme: Schema.optionalWith(RegistryTheme, { default: () => ({ _tag: "Unresolved" as const }) }),
  /** 出自 (公式ディレクトリ / shadcn/ui / コミュニティ)。v0.6 以前の行は運営者の登録として読み、ディレクトリの同期が Official に直す */
  listing: Schema.optionalWith(RegistryListing, { default: () => operatorListing }),
}) {}

export const previewContextOf = (registry: Registry, now: number): RegistryPreviewContext => ({
  configHash: buildConfigHash(registry.previewConfig),
  tokensHash: tokensHash(registry.previewConfig),
  onHold: isPreviewOnHold(registry.theme, now),
})

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

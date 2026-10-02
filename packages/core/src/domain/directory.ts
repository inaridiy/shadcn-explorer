import { Schema } from "effect"
import type { RegistryId } from "./ids.js"
import type { WireDirectoryEntry } from "./registry-wire.js"

/**
 * レジストリの出自 (v0.7)。検索・ギャラリーのバッジと、取り込みのライフサイクルを決める。
 * - Official:  shadcn 公式ディレクトリ (registries.json) に載っている。自動で全部取り込む。listed=false は掲載が外れたもの
 * - Shadcn:    ui.shadcn.com 自身 (ディレクトリには載っていない。比較の基準として運営者が登録する)
 * - Community: それ以外。GitHub Issues・メール (将来は Stripe Checkout) の申請を運営者が取り込む
 */
export const RegistryListing = Schema.Union(
  Schema.TaggedStruct("Official", { directoryName: Schema.String, listed: Schema.Boolean }),
  Schema.TaggedStruct("Shadcn", {}),
  Schema.TaggedStruct("Community", {
    requestedVia: Schema.Literal("github", "email", "operator", "checkout"),
    /** Issue の URL など */
    reference: Schema.NullOr(Schema.String),
  }),
)
export type RegistryListing = typeof RegistryListing.Type
export type ListingTag = RegistryListing["_tag"]

export const operatorListing: RegistryListing = { _tag: "Community", requestedVia: "operator", reference: null }

/**
 * 公式ディレクトリの 1 件と、取り込みの状態。
 *   New ─intake→ Imported
 *     └──────→ Skipped (大きすぎる・空・見つからない・取得の失敗が続いた)
 *   (どの状態でも) ディレクトリから消えたら Delisted
 */
export const DirectoryEntryState = Schema.Literal("New", "Imported", "Skipped", "Delisted")
export type DirectoryEntryState = typeof DirectoryEntryState.Type

export interface DirectoryEntry {
  /** `@acme` */
  readonly name: string
  /** アイテムの URL テンプレート (`https://acme.dev/r/{name}.json`) */
  readonly url: string
  readonly homepage: string | null
  readonly description: string | null
  readonly healthStatus: string | null
  readonly healthScore: number | null
  readonly rankingScore: number | null
  /** ディレクトリが数えたアイテム数 (無いこともある) */
  readonly itemCount: number | null
  /** ディレクトリ側で非表示 */
  readonly hidden: boolean
  readonly state: DirectoryEntryState
  readonly registryId: RegistryId | null
  readonly skipReason: string | null
  /** 一時的な失敗の回数 (取り込みの再試行の上限に使う) */
  readonly attempts: number
  readonly firstSeenAt: number
  readonly checkedAt: number
}

export const mergeDirectoryEntry = (
  previous: DirectoryEntry | undefined,
  wire: WireDirectoryEntry,
  now: number,
): DirectoryEntry => {
  return {
    name: wire.name,
    url: wire.url,
    homepage: wire.homepage ?? null,
    description: wire.description ?? null,
    healthStatus: wire.health?.status ?? null,
    healthScore: wire.health?.score ?? null,
    rankingScore: wire.ranking?.score ?? null,
    itemCount: wire.ranking?.itemCount ?? null,
    hidden: wire.health?.hidden === true,
    // 掲載が外れていたものが戻ってきたら、取り込み済みでなければ New に戻す
    state: previous ? (previous.state === "Delisted" ? (previous.registryId ? "Imported" : "New") : previous.state) : "New",
    registryId: previous?.registryId ?? null,
    skipReason: previous?.skipReason ?? null,
    attempts: previous?.attempts ?? 0,
    firstSeenAt: previous?.firstSeenAt ?? now,
    checkedAt: now,
  }
}

export interface IntakeLimits {
  /** 1 レジストリのアイテム数の上限 */
  readonly maxItems: number
  /** 一時的な失敗をこの回数まで再試行する */
  readonly maxAttempts: number
  /** 1 回で取り込む数 */
  readonly limit: number
}

export interface IntakePlan {
  readonly importNow: ReadonlyArray<DirectoryEntry>
  readonly skip: ReadonlyArray<{ readonly entry: DirectoryEntry; readonly reason: string }>
}

/**
 * 次に取り込む公式レジストリを決める (純粋関数)。
 * - 非表示・アイテム数の上限超えは Skipped にする (日々の再判定はしない。ディレクトリの値が変われば New に戻す運用は手動)
 * - 健康状態が unavailable のものは今日は見送る (一時的なことがあるので Skipped にはしない)
 * - 並びは ranking の高い順、同点ならアイテム数の少ない順 (レジストリ数が早く増え、人気のものから揃う)
 */
export const planDirectoryIntake = (entries: ReadonlyArray<DirectoryEntry>, limits: IntakeLimits): IntakePlan => {
  const skip: Array<{ entry: DirectoryEntry; reason: string }> = []
  const candidates: Array<DirectoryEntry> = []
  for (const entry of entries) {
    if (entry.state !== "New") continue
    if (entry.hidden) skip.push({ entry, reason: "hidden in the directory" })
    else if (entry.itemCount !== null && entry.itemCount > limits.maxItems)
      skip.push({ entry, reason: `too large (${entry.itemCount} items > ${limits.maxItems})` })
    else if (entry.attempts >= limits.maxAttempts) skip.push({ entry, reason: `failed ${entry.attempts} times` })
    else if (entry.healthStatus !== "unavailable") candidates.push(entry)
  }
  candidates.sort(
    (a, b) =>
      (b.rankingScore ?? b.healthScore ?? 0) - (a.rankingScore ?? a.healthScore ?? 0) ||
      (a.itemCount ?? Number.MAX_SAFE_INTEGER) - (b.itemCount ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name),
  )
  return { importNow: candidates.slice(0, limits.limit), skip }
}

/**
 * URL テンプレートの比較 (末尾の .json の有無を揃える)。ディレクトリ側が `{style}` 入りなら、どの style で解決したものとも一致させる
 */
export const sameItemTemplate = (a: string, b: string) => {
  const norm = (t: string) => t.replace(/\.json$/, "")
  const [x, y] = [norm(a), norm(b)]
  if (x === y) return true
  const pattern = (t: string) => new RegExp(`^${t.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{style\}/g, "[^/]+").replace(/\{name\}/g, "\\{name\\}")}$`)
  return (x.includes("{style}") && pattern(x).test(y)) || (y.includes("{style}") && pattern(y).test(x))
}

/** 再同期の間隔 (v0.7: 各レジストリ 7 日に 1 回) を過ぎたか */
export const isResyncDue = (lastSyncedAt: number | null, now: number, intervalMs: number) =>
  lastSyncedAt === null || now - lastSyncedAt >= intervalMs

/** バッジと絞り込みに使う出自。掲載が外れた公式レジストリは Official として扱わない */
export const listingBadge = (listing: RegistryListing): ListingTag =>
  listing._tag === "Official" && !listing.listed ? "Community" : listing._tag

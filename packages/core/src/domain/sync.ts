import type { ComponentSnapshot } from "./component.js"
import type { ComponentId } from "./ids.js"

/**
 * レジストリ同期の差分計画。
 * 既存 (id → contentHash) と取得結果を比較し、何を再処理すべきかを決める純粋関数。
 */
export interface SyncPlan {
  readonly added: ReadonlyArray<ComponentSnapshot>
  readonly changed: ReadonlyArray<ComponentSnapshot>
  readonly unchanged: ReadonlyArray<ComponentId>
  readonly removed: ReadonlyArray<ComponentId>
}

export const planSync = (
  existing: ReadonlyMap<ComponentId, string>,
  fetched: ReadonlyArray<ComponentSnapshot>,
): SyncPlan => {
  const added: Array<ComponentSnapshot> = []
  const changed: Array<ComponentSnapshot> = []
  const unchanged: Array<ComponentId> = []
  const seen = new Set<ComponentId>()

  for (const snapshot of fetched) {
    if (seen.has(snapshot.id)) continue // レジストリ内の重複名は先勝ち
    seen.add(snapshot.id)
    const prev = existing.get(snapshot.id)
    if (prev === undefined) added.push(snapshot)
    else if (prev !== snapshot.contentHash) changed.push(snapshot)
    else unchanged.push(snapshot.id)
  }
  const removed = [...existing.keys()].filter((id) => !seen.has(id))
  return { added, changed, unchanged, removed }
}

/** 再エンリッチが必要なもの (新規 + 変更) */
export const needsEnrichment = (plan: SyncPlan): ReadonlyArray<ComponentSnapshot> => [...plan.added, ...plan.changed]

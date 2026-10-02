/**
 * エンリッチの lease (D1)。キューの消費者が同じコンポーネントを同時に処理しないようにする。
 * - 期限切れか、同じメッセージ (再配信) のときだけ取り直せる。別のメッセージが持っていれば取れない
 * - 消費者がタイムアウト・クラッシュしても expires_at を過ぎれば他のメッセージが取れる
 */
export interface Lease {
  readonly messageId: string
  readonly instanceId: string | null
}

/** lease を取る。取れたら (自分の lease になったら) その内容、別のメッセージが持っていれば null */
export const acquireLease = async (db: D1Database, componentId: string, messageId: string, ttlMs: number): Promise<Lease | null> => {
  const now = Date.now()
  await db
    .prepare(
      `insert into enrich_leases (component_id, message_id, instance_id, expires_at) values (?1, ?2, null, ?3)
       on conflict (component_id) do update set
         instance_id = case when enrich_leases.message_id = excluded.message_id then enrich_leases.instance_id else null end,
         message_id = excluded.message_id,
         expires_at = excluded.expires_at
       where enrich_leases.message_id = excluded.message_id or enrich_leases.expires_at < ?4`,
    )
    .bind(componentId, messageId, now + ttlMs, now)
    .run()
  const row = await db
    .prepare(`select message_id, instance_id from enrich_leases where component_id = ?`)
    .bind(componentId)
    .first<{ message_id: string; instance_id: string | null }>()
  return row && row.message_id === messageId ? { messageId, instanceId: row.instance_id } : null
}

/** 起動した Workflow を記録し、期限を延ばす (自分の lease のときだけ) */
export const extendLease = (db: D1Database, componentId: string, messageId: string, instanceId: string, ttlMs: number) =>
  db
    .prepare(`update enrich_leases set instance_id = ?, expires_at = ? where component_id = ? and message_id = ?`)
    .bind(instanceId, Date.now() + ttlMs, componentId, messageId)
    .run()

export const releaseLease = (db: D1Database, componentId: string, messageId: string) =>
  db.prepare(`delete from enrich_leases where component_id = ? and message_id = ?`).bind(componentId, messageId).run()

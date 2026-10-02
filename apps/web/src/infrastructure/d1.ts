import { Effect } from "effect"
import { PersistenceError } from "@shadcn-explorer/core/ports"

/**
 * アダプタが使う D1 の面。D1Database そのものか、読み取りレプリカに回せるセッション (withSession) を渡す。
 * レプリカに回すのは公開の読み取りだけ (runtime.ts の read runtime)。Workflow・キュー・cron はプライマリを使う
 * (前のステップの書き込みを別の isolate から読むので、レプリカの遅れで状態を読み違えると生成をやり直してしまう)
 */
export type D1Client = Pick<D1Database, "prepare" | "batch">

/** D1 呼び出しを Effect に持ち上げ、失敗を PersistenceError に正規化する */
export const d1 = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, PersistenceError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new PersistenceError({ operation, cause }) })

/** D1 のバインド変数上限 (100) を超えないように分割する */
export const chunk = <A>(items: ReadonlyArray<A>, size: number): Array<Array<A>> => {
  const out: Array<Array<A>> = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ")

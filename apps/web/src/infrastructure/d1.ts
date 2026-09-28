import { Effect } from "effect"
import { PersistenceError } from "@shadcn-explorer/core/ports"

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

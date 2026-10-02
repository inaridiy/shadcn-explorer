import { describeError, type RunResult } from "~/lib/runtime"

/** フォームに出したいので throw せず { ok, value | error } で返す (運営者の操作の server fn 用) */
export const toResult = <A>(result: RunResult<A, { readonly _tag: string }>) =>
  result._tag === "Success"
    ? { ok: true as const, value: result.value }
    : {
        ok: false as const,
        error: result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 },
      }

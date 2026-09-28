import { env, waitUntil } from "cloudflare:workers"
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect"
import { Application } from "@shadcn-explorer/core"
import type { InlineJob } from "~/infrastructure/job-scheduler"
import { type AppServices, makeAppLayer } from "~/infrastructure/layers"

/**
 * アプリケーション全体で 1 つの ManagedRuntime (isolate 単位でキャッシュ)。
 * Layer はここで一度だけ構築され、server fn / Hono / Workflow から共有される。
 */
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

const runInlineJob = (job: InlineJob): Effect.Effect<void, unknown, AppServices> =>
  job._tag === "Sync"
    ? Application.syncRegistry(job.registryId).pipe(Effect.asVoid)
    : Effect.forEach(job.componentIds, (id) => Application.enrichComponent(id), { discard: true })

/**
 * ローカル開発用のインラインジョブキュー。
 * workerd ではリクエストの waitUntil が全て解決した後に登録された I/O は完了しないため、
 * ジョブ内から投入された後続ジョブ (同期 → エンリッチ) も同じ drain ループ (= 同じ waitUntil) で処理する。
 */
const queue: Array<InlineJob> = []
let draining: Promise<void> | null = null

const drain = async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    await getRuntime()
      .runPromise(runInlineJob(job).pipe(Effect.catchAllCause((c) => Effect.logError("inline job failed", c))))
      .catch(() => undefined)
  }
  draining = null
}

const dispatch = (job: InlineJob) => {
  queue.push(job)
  if (draining === null) {
    draining = drain()
    waitUntil(draining)
  }
}

export const getRuntime = () => (runtime ??= ManagedRuntime.make(makeAppLayer(env, dispatch)))

/** 失敗を「ドメインエラー (Fail)」と「欠陥 (Die)」に分けて返す */
export type RunResult<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E }
  | { readonly _tag: "Defect"; readonly message: string }

export const runApp = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<RunResult<A, E>> => {
  const exit = await getRuntime().runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return { _tag: "Success", value: exit.value }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) return { _tag: "Failure", error: failure.value }
  console.error(Cause.pretty(exit.cause))
  return { _tag: "Defect", message: "内部エラーが発生しました" }
}

/** 成功値を返すか、ユーザー向けメッセージ付きの Error を throw する (loader 向け) */
export const runAppOrThrow = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> => {
  const result = await runApp(effect)
  if (result._tag === "Success") return result.value
  if (result._tag === "Failure") throw new AppError(describeError(result.error))
  throw new AppError({ code: "INTERNAL", message: result.message, status: 500 })
}

export interface ErrorInfo {
  readonly code: string
  readonly message: string
  readonly status: number
}

export class AppError extends Error {
  readonly code: string
  readonly status: number
  constructor(info: ErrorInfo) {
    super(info.message)
    this.code = info.code
    this.status = info.status
  }
}

/** ドメイン/アプリケーションエラー → ユーザー向けメッセージと HTTP ステータス (プレゼンテーション層の責務) */
export const describeError = (error: { readonly _tag: string } & Record<string, unknown>): ErrorInfo => {
  switch (error._tag) {
    case "InvalidRegistryInput":
      return { code: error._tag, message: String(error.reason), status: 400 }
    case "NamespaceNotFound":
      return { code: error._tag, message: `${String(error.namespace)} は shadcn のレジストリディレクトリに見つかりません`, status: 404 }
    case "RegistryNotFound":
      return {
        code: error._tag,
        message: `registry.json が見つかりませんでした (試した URL: ${(error.tried as Array<string>).join(", ")})`,
        status: 404,
      }
    case "RegistryAlreadyRegistered":
      return { code: error._tag, message: `既に登録済みです (${String(error.registryId)})`, status: 409 }
    case "RegistryTooLarge":
      return { code: error._tag, message: `アイテム数 ${String(error.itemCount)} が上限 ${String(error.limit)} を超えています`, status: 422 }
    case "RegistryEmpty":
      return { code: error._tag, message: "レジストリにアイテムがありません", status: 422 }
    case "UserQuotaExceeded":
      return {
        code: error._tag,
        message: `今月の登録上限を超えます (使用済み ${String(error.used)} + 今回 ${String(error.requested)} > 上限 ${String(error.limit)} アイテム)`,
        status: 429,
      }
    case "NotRegistryOwner":
      return { code: error._tag, message: "登録者のみ実行できます", status: 403 }
    case "RegistryNotFoundById":
    case "ComponentNotFound":
      return { code: error._tag, message: "見つかりませんでした", status: 404 }
    case "IllegalRegistryTransition":
      return { code: error._tag, message: "現在の状態ではこの操作はできません (同期中など)", status: 409 }
    case "RegistryFetchError":
      return { code: error._tag, message: `レジストリの取得に失敗しました: ${String(error.reason)}`, status: 502 }
    case "SearchImageNotFound":
      return { code: error._tag, message: "検索画像が見つかりません", status: 404 }
    default:
      return { code: error._tag, message: "処理に失敗しました", status: 500 }
  }
}

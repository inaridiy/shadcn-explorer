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
    ? Application.syncRegistry(job.registryId, { forceTheme: job.forceTheme }).pipe(
        // テーマが registry.json で決まらなければ、その場でエージェントを回す (本番は SyncRegistryWorkflow)
        Effect.flatMap((report) => (report.themeAgent ? Application.runThemeAgentInline(job.registryId) : Effect.void)),
        Effect.asVoid,
      )
    : Effect.forEach(job.componentIds, (id) => Application.enrichComponent(id), { discard: true })

/**
 * インラインのジョブキュー (ローカル開発と JOB_RUNNER=inline で使う)。
 * workerd ではリクエストの waitUntil が全て解決した後に登録された I/O は完了しないため、
 * ジョブ内から投入された後続ジョブ (同期 → エンリッチ) も同じ drain ループ (= 同じ waitUntil) で処理する。
 * - 同時に INLINE_CONCURRENCY 本まで回す (既定 1)。コンテナの数 (POOL_SIZE) が自然な上限
 * - 同じコンポーネントは、キューにあるか処理中なら積み直さない (backlog sweeper を何度起こしても重複しない)
 */
const queue: Array<InlineJob> = []
const pendingIds = new Set<string>()
let running = 0
let draining: Promise<void> | null = null

const jobKey = (job: InlineJob) => (job._tag === "Sync" ? `sync:${job.registryId}` : `enrich:${job.componentIds.join(",")}`)

const worker = async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    running++
    try {
      await getRuntime()
        .runPromise(runInlineJob(job).pipe(Effect.catchAllCause((c) => Effect.logError("inline job failed", c))))
        .catch(() => undefined)
    } finally {
      running--
      pendingIds.delete(jobKey(job))
    }
  }
}

const drain = async () => {
  const concurrency = Math.max(1, Number(env.INLINE_CONCURRENCY) || 1)
  // 後続ジョブが積まれ続ける間はワーカーを補充する
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1000))
  while (queue.length > 0 || running > 0) {
    const workers = Array.from({ length: Math.max(0, Math.min(concurrency - running, queue.length)) }, worker)
    // ワーカーを足さなかった周も必ずタイマーで待つ (空の Promise.all はすぐ解決し、I/O に譲らない空回りになる)
    await (workers.length > 0 ? Promise.race([Promise.all(workers), tick()]) : tick())
  }
  draining = null
}

const dispatch = (job: InlineJob) => {
  // エンリッチは 1 件ずつのジョブに分ける (並列に回すため)
  const jobs: ReadonlyArray<InlineJob> =
    job._tag === "Enrich" ? job.componentIds.map((id) => ({ _tag: "Enrich" as const, componentIds: [id] })) : [job]
  for (const j of jobs) {
    const key = jobKey(j)
    if (pendingIds.has(key)) continue
    pendingIds.add(key)
    // 同期は先頭に入れる (同期が終わらないとエンリッチするアイテムが出てこない)
    if (j._tag === "Sync") queue.unshift(j)
    else queue.push(j)
  }
  if (draining === null) {
    draining = drain()
    waitUntil(draining)
  }
}

/** インラインのキューの状態 (一括取り込みの進捗表示用) */
export const inlineQueueStatus = () => ({ queued: queue.length, running })

export const getRuntime = () => (runtime ??= ManagedRuntime.make(makeAppLayer(env, dispatch)))

/**
 * 公開の読み取り (検索・一覧・詳細) 用の runtime。D1 を読み取りレプリカに回せるセッションで包む
 * (D1 のプライマリは ENAM にあり、日本からは 1 往復 150〜250ms)。レプリカは数秒遅れることがあるので、
 * 書き込みや「直前の書き込みを読む」処理 (Workflow・キュー・運営者の操作) には使わない。
 * セッションは isolate で共有する: 同じセッション内では読みの単調性 (ブックマーク) が保たれる
 */
let readRuntime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined
const getReadRuntime = () =>
  (readRuntime ??= ManagedRuntime.make(makeAppLayer(env, dispatch, { db: env.DB.withSession("first-unconstrained") })))

/** 失敗を「ドメインエラー (Fail)」と「欠陥 (Die)」に分けて返す */
export type RunResult<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly error: E }
  | { readonly _tag: "Defect"; readonly message: string }

const toResult = <A, E>(exit: Exit.Exit<A, E>): RunResult<A, E> => {
  if (Exit.isSuccess(exit)) return { _tag: "Success", value: exit.value }
  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) return { _tag: "Failure", error: failure.value }
  console.error(Cause.pretty(exit.cause))
  return { _tag: "Defect", message: "内部エラーが発生しました" }
}

export const runApp = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<RunResult<A, E>> =>
  toResult(await getRuntime().runPromiseExit(effect))

/** 公開の読み取り専用。レプリカから読む (数秒古いことがある) */
export const runRead = async <A, E>(effect: Effect.Effect<A, E, AppServices>): Promise<RunResult<A, E>> =>
  toResult(await getReadRuntime().runPromiseExit(effect))

/** 成功値を返すか、ユーザー向けメッセージ付きの Error を throw する (loader 向け) */
export const runAppOrThrow = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> => orThrow(await runApp(effect))

/** runRead の loader 向け */
export const runReadOrThrow = async <A, E extends { readonly _tag: string }>(
  effect: Effect.Effect<A, E, AppServices>,
): Promise<A> => orThrow(await runRead(effect))

const orThrow = <A, E extends { readonly _tag: string }>(result: RunResult<A, E>): A => {
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
    case "InvalidThemeConfig":
      return { code: error._tag, message: `テーマの設定が不正です: ${(error.problems as Array<string>).join("; ")}`, status: 422 }
    case "ThemeProposalNotFound":
      return { code: error._tag, message: "承認待ちのテーマの提案がありません", status: 409 }
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

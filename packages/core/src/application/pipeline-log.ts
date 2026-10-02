import { Clock, Effect } from "effect"
import {
  ACTIVE_WINDOW_MS,
  type ComponentId,
  type PipelineEvent,
  type RegistryId,
  type RegistryTheme,
  type StoredPipelineEvent,
  isTerminalEvent,
} from "../domain/index.js"
import { PipelineLog, type PipelineLogFilter } from "../ports/index.js"

/**
 * 生成過程の公開ログを書く。ログの失敗で生成を止めない (握りつぶす)。
 * 状態を保存する地点 (ドキュメント・デモ・ビルド・撮影・インデックス) から呼ぶ。
 * Workflow のステップが永続化エラーで再実行されると同じイベントが 2 回入ることがある (画面側で重複を畳む)
 */
export const emit = (event: Omit<PipelineEvent, "at" | "detail"> & { readonly detail?: PipelineEvent["detail"] }) =>
  Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis
    yield* (yield* PipelineLog).append({ ...event, detail: event.detail ?? {}, at })
  }).pipe(Effect.ignore)

export const pipelineEvents = (filter: PipelineLogFilter) => Effect.flatMap(PipelineLog, (log) => log.list(filter))

export interface ActiveBuild {
  readonly componentId: ComponentId
  readonly registryId: RegistryId
  readonly latest: StoredPipelineEvent
  readonly startedAt: number
}

export interface LiveSnapshot {
  /** 進行中 (最後のイベントが終わりでなく、ACTIVE_WINDOW_MS 以内) */
  readonly active: ReadonlyArray<ActiveBuild>
  /** 直近にプレビューが撮れたもの (新しい順) */
  readonly captured: ReadonlyArray<StoredPipelineEvent>
  /** 直近 24 時間でインデックスまで終わった数 */
  readonly finishedToday: number
  /** 次のポーリングのカーソル */
  readonly cursor: number
}

/** /live とホームのティッカー用: 直近のイベントから、進行中のものと撮れたばかりのものを組み立てる */
export const liveSnapshot = (filter: { readonly registryId?: RegistryId } = {}) =>
  Effect.gen(function* () {
    const log = yield* PipelineLog
    const now = yield* Clock.currentTimeMillis
    const recent = yield* log.list({ ...filter, since: now - 24 * 3600 * 1000, limit: 2000 })
    const latest = new Map<ComponentId, StoredPipelineEvent>()
    const firstSeen = new Map<ComponentId, number>()
    for (const e of recent) {
      if (!e.componentId) continue
      // 計画 (start) から新しい実行が始まる
      if (e.stage === "plan" && e.status === "start") firstSeen.set(e.componentId, e.at)
      else if (!firstSeen.has(e.componentId)) firstSeen.set(e.componentId, e.at)
      latest.set(e.componentId, e)
    }
    const active = [...latest.values()]
      .filter((e) => !isTerminalEvent(e) && now - e.at < ACTIVE_WINDOW_MS)
      .sort((a, b) => b.at - a.at)
      .map(
        (e): ActiveBuild => ({
          componentId: e.componentId!,
          registryId: e.registryId,
          latest: e,
          startedAt: firstSeen.get(e.componentId!) ?? e.at,
        }),
      )
    const captured = recent.filter((e) => e.stage === "capture" && e.status === "ok").reverse().slice(0, 24)
    return {
      active,
      captured,
      finishedToday: recent.filter((e) => e.stage === "index" && e.status === "ok").length,
      cursor: recent.at(-1)?.id ?? 0,
    } satisfies LiveSnapshot
  })

/** 保持期間 (30 日) を過ぎたイベントを消す (日次 cron) */
export const prunePipelineLog = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  yield* (yield* PipelineLog).prune(now - 30 * 24 * 3600 * 1000)
})

/** テーマの判定結果を公開ログの 1 行にする */
export const describeTheme = (theme: RegistryTheme): string => {
  switch (theme._tag) {
    case "Unresolved":
      return "Theme: not detected yet"
    case "AgentPending":
      return "Theme: an agent is reading the install docs (previews wait for it)"
    case "Proposed":
      return "Theme: a low-confidence guess is waiting for review; previews use neutral"
    case "Failed":
      return "Theme: detection failed; previews use neutral"
    case "Resolved":
      return theme.source === "none"
        ? "Theme: neutral (the install steps add no theme)"
        : theme.source === "registry-item"
          ? "Theme: applied from registry.json"
          : theme.source === "agent"
            ? "Theme: applied from the install docs"
            : "Theme: set by the maintainer"
  }
}

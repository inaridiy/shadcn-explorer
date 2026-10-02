import type { ComponentId, RegistryId } from "./ids.js"

/**
 * 生成過程の公開ログ (v0.7、"build theater")。コンポーネントのページ・レジストリのページ・/live で、生成の流れを見せる。
 * 公開してよいものだけを載せる: ステップ・所要時間・試行回数・回避策・デモのコード・スクショのキー・ビルドエラーの要約。
 * 金額・プロンプト・LLM の生のエラー・エージェントの会話は載せない (運営者は usage_records と preview_agent_runs で見る)
 */
export type PipelineStage =
  | "sync"
  | "theme"
  | "plan"
  | "docs"
  | "demo"
  | "build"
  | "repair"
  | "agent"
  | "capture"
  | "index"

export type PipelineStatus = "start" | "ok" | "warn" | "error" | "info"

export interface PipelineEvent {
  readonly at: number
  readonly registryId: RegistryId
  readonly componentId: ComponentId | null
  readonly stage: PipelineStage
  readonly status: PipelineStatus
  /** 英語の 1 行 (画面にそのまま出す) */
  readonly message: string
  /** 公開してよい値だけ (durationMs, attempt, lines, code, lightKey …) */
  readonly detail: Readonly<Record<string, string | number>>
}

export interface StoredPipelineEvent extends PipelineEvent {
  readonly id: number
}

/** 1 行に切り詰める (ビルドエラーの先頭など) */
export const oneLine = (text: string, max = 240) => {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 進行中とみなす時間。これより古い「最後のイベントが終わりでない」コンポーネントは止まったとみなす */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000

/** そのコンポーネントの生成が終わったことを表すイベントか (インデックス完了・計画で何もしない・失敗の確定) */
export const isTerminalEvent = (e: PipelineEvent) =>
  (e.stage === "index" && e.status === "ok") ||
  (e.stage === "plan" && (e.status === "info" || e.status === "warn")) ||
  e.status === "error"

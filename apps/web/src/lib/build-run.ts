import { type LiveEvent, PIPELINE_STEPS, stepIndexOf } from "~/lib/live"

/**
 * 公開ログ (LiveEvent) を「1 回の実行」に分けて、ステップごとの状態に畳む。
 * コンポーネントのページの Build カードと、ビルドログのページ (/c/$registryId/$name/build) で共有する。
 * 金額は扱わない (公開ログにも載っていない)
 */

/** 進行中とみなす時間 (core の ACTIVE_WINDOW_MS と同じ)。これより古い途中の実行は止まったとみなす */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000

export type StepState = "done" | "reused" | "current" | "pending" | "failed" | "skipped"

export interface StepView {
  readonly stage: (typeof PIPELINE_STEPS)[number]["stage"]
  readonly label: string
  readonly state: StepState
  /** 前のイベントからこのステップの最後のイベントまで */
  readonly durationMs: number | null
  /** 補足 (修正回数・撮れたもの …) */
  readonly note: string | null
}

export type RunOutcome = "running" | "done" | "failed" | "waiting" | "stalled"

export interface RunView {
  /** 計画 (plan:start) のイベント ID。無ければ最初のイベントの ID */
  readonly id: number
  readonly startedAt: number
  readonly endedAt: number
  readonly events: ReadonlyArray<LiveEvent>
  readonly outcome: RunOutcome
}

/** ログの各ステージがどのステップに属するか (repair と agent はビルドの一部) */
const STEP_OF: Partial<Record<LiveEvent["stage"], number>> = { docs: 0, demo: 1, build: 2, repair: 2, agent: 2, capture: 3, index: 4 }

const isTerminal = (e: LiveEvent) =>
  (e.stage === "index" && e.status === "ok") || (e.stage === "plan" && (e.status === "info" || e.status === "warn")) || e.status === "error"

/** Workflow のステップが再実行されると同じイベントが続けて入ることがある。直前と同じものは畳む */
export const dedupeEvents = (events: ReadonlyArray<LiveEvent>) =>
  events.filter((e, i) => {
    const prev = events[i - 1]
    return !prev || prev.stage !== e.stage || prev.status !== e.status || prev.message !== e.message
  })

const outcomeOf = (events: ReadonlyArray<LiveEvent>, now: number): RunOutcome => {
  const last = events.at(-1)!
  if (last.stage === "index" && last.status === "ok") return "done"
  if (last.status === "error") return "failed"
  if (last.stage === "plan" && (last.status === "warn" || last.status === "info")) return "waiting"
  return now - last.at < ACTIVE_WINDOW_MS ? "running" : "stalled"
}

/** plan:start ごとに実行を区切る (古い順)。計画より前のイベントは 1 つ目の実行にまとめる */
export const splitRuns = (events: ReadonlyArray<LiveEvent>, now = Date.now()): ReadonlyArray<RunView> => {
  const runs: Array<Array<LiveEvent>> = []
  for (const e of dedupeEvents(events)) {
    if (runs.length === 0 || (e.stage === "plan" && e.status === "start")) runs.push([])
    runs.at(-1)!.push(e)
  }
  return runs.map((evs) => ({
    id: evs[0]!.id,
    startedAt: evs[0]!.at,
    endedAt: evs.at(-1)!.at,
    events: evs,
    outcome: outcomeOf(evs, now),
  }))
}

/** 計画のメッセージ ("Started: demo → build → capture → index") から、この実行でやるステップを読む */
const plannedSteps = (run: RunView): Set<number> | null => {
  const plan = run.events.find((e) => e.stage === "plan" && e.status === "start")
  const m = plan?.message.match(/^Started:\s*(.+)$/)
  if (!m) return null
  const steps = new Set<number>()
  for (const name of m[1]!.split(/\s*→\s*/)) {
    const i = PIPELINE_STEPS.findIndex((s) => s.stage === name.trim())
    if (i >= 0) steps.add(i)
  }
  return steps.size > 0 ? steps : null
}

const noteOf = (stage: StepView["stage"], evs: ReadonlyArray<LiveEvent>): string | null => {
  const ok = evs.filter((e) => e.status === "ok")
  switch (stage) {
    case "build": {
      const repairs = evs.filter((e) => e.stage === "repair" && e.status === "ok").length
      const agent = evs.some((e) => e.stage === "agent")
      return [repairs > 0 ? `${repairs} repair${repairs > 1 ? "s" : ""}` : null, agent ? "coding agent" : null].filter(Boolean).join(" · ") || null
    }
    case "capture": {
      const m = ok.at(-1)?.message.match(/^Captured (.+)$/)
      return m ? m[1]! : null
    }
    case "index": {
      const last = ok.at(-1)
      return last ? (last.message.includes("screenshots") ? "text + screenshots" : "text") : null
    }
    default:
      return null
  }
}

/** 1 回の実行をステップの状態に畳む */
export const stepsOf = (run: RunView): ReadonlyArray<StepView> => {
  const evs = run.events.filter((e) => e.stage !== "plan")
  const planned = plannedSteps(run)
  const last = run.events.at(-1)!
  // 進行中のステップの位置 (0..5、5 = 全部終わった)
  const cursor = run.outcome === "done" ? PIPELINE_STEPS.length : stepIndexOf(last)
  const firstTouched = evs.reduce<number>((min, e) => Math.min(min, STEP_OF[e.stage] ?? min), PIPELINE_STEPS.length)
  return PIPELINE_STEPS.map((step, i): StepView => {
    const mine = evs.filter((e) => STEP_OF[e.stage] === i)
    const base = { stage: step.stage, label: step.label, note: noteOf(step.stage, mine) }
    if (mine.length > 0) {
      const lastOfStep = mine.at(-1)!
      const firstIndex = run.events.indexOf(mine[0]!)
      const from = run.events[Math.max(0, firstIndex - 1)]!.at
      const durationMs = lastOfStep.at - from
      if (lastOfStep.status === "error") return { ...base, state: "failed", durationMs }
      if (lastOfStep.status === "ok" && !(step.stage === "build" && lastOfStep.stage === "repair"))
        return { ...base, state: "done", durationMs }
      // 途中 (start / 修正待ちの warn)。止まったままなら失敗として出す
      return run.outcome === "running" ? { ...base, state: "current", durationMs: null } : { ...base, state: "failed", durationMs }
    }
    // この実行の計画に入っていないステップは、前の実行の結果を使い回している
    const reused = planned ? !planned.has(i) && i < Math.max(...planned) : i < firstTouched
    if (reused) return { ...base, state: "reused", durationMs: null }
    if (run.outcome !== "running") return { ...base, state: "skipped", durationMs: null }
    return { ...base, state: i === cursor ? "current" : "pending", durationMs: null }
  })
}

/** 状態の要約 (DTO の status) からステップを組み立てる。公開ログが無い (30 日より前に作った) ときの代わり */
export const stepsFromStatus = (status: { readonly doc: string; readonly preview: string; readonly index: string }): ReadonlyArray<StepView> => {
  const built = status.preview === "Built" || status.preview === "Captured"
  const state = (i: number): StepState => {
    switch (i) {
      case 0:
        return status.doc === "Generated" ? "done" : status.doc === "Failed" ? "failed" : "pending"
      case 1:
        return built ? "done" : "pending"
      case 2:
        return built ? "done" : status.preview === "Failed" ? "failed" : "pending"
      case 3:
        return status.preview === "Captured" ? "done" : "pending"
      default:
        return status.index === "Indexed" ? "done" : status.index === "Failed" ? "failed" : "pending"
    }
  }
  return PIPELINE_STEPS.map((s, i) => ({ stage: s.stage, label: s.label, state: state(i), durationMs: null, note: null }))
}

/** 秒の表示 ("14.2s"、1 分以上は "1m 05s") */
export const formatDuration = (ms: number) => {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}

/** 実行開始からの経過 ("04.2" / "1:05.3") */
export const formatOffset = (ms: number) => {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const s = (total - m * 60).toFixed(1).padStart(4, "0")
  return m > 0 ? `${m}:${s}` : s
}

/** 行単位の差分 (LCS)。デモの修正 (repair) で何が変わったかを見せる */
export type DiffLine = { readonly kind: "same" | "add" | "del"; readonly text: string; readonly line: number }

export const diffLines = (before: string, after: string): ReadonlyArray<DiffLine> => {
  const a = before.split("\n")
  const b = after.split("\n")
  // 大きすぎるものは比べない (公開ログのデモは 8000 文字まで)
  if (a.length * b.length > 400_000) return []
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: Array<DiffLine> = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]!, line: j + 1 })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ kind: "add", text: b[j]!, line: j + 1 })
      j++
    } else {
      out.push({ kind: "del", text: a[i]!, line: j + 1 })
      i++
    }
  }
  return out
}

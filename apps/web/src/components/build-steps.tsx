import type { StepState } from "~/lib/build-run"
import { cn } from "~/lib/utils"

/** ステップの状態の点。済み = 塗り、進行中 = signal で点滅、未着手 = 輪、失敗 = 赤、使い回し = 薄い塗り、対象外 = 破線 */
export function StepDot({ state, className }: { state: StepState; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "box-border size-2 shrink-0 justify-self-center rounded-full",
        state === "done" && "bg-foreground",
        state === "reused" && "bg-muted-foreground/45",
        state === "current" && "animate-signal bg-signal",
        state === "pending" && "border-[1.5px] border-zinc-500",
        state === "failed" && "bg-destructive",
        state === "skipped" && "border-[1.5px] border-dashed border-zinc-500/70",
        className,
      )}
    />
  )
}

/** 状態を読み上げ・ツールチップ用の英語にする */
export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: "done",
  reused: "reused from an earlier run",
  current: "running",
  pending: "pending",
  failed: "failed",
  skipped: "not part of this run",
}

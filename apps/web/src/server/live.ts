import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import { Application } from "@shadcn-explorer/core"
import { planDirectoryIntake } from "@shadcn-explorer/core/domain"
import { ExplorerConfig } from "@shadcn-explorer/core/ports"
import { runReadOrThrow } from "~/lib/runtime"

/**
 * /live の公開データ。生成ログ自体は /api/live/* (Hono、エッジキャッシュ) から取るので、ここはそれ以外だけ。
 * 公式ディレクトリの取り込み状況は件数と次の数件の名前だけを出す (見送った理由などの運営情報は出さない)
 */
export const directoryProgressFn = createServerFn({ method: "GET" }).handler(async () =>
  runReadOrThrow(
    Effect.gen(function* () {
      const { entries, counts } = yield* Application.directoryStatus
      const { budget, enrichment } = yield* ExplorerConfig
      // 取り込みと同じ計画で「次に入るもの」と「入らないもの」(見送り) を決める
      const plan = planDirectoryIntake(entries, {
        maxItems: budget.maxItemsPerRegistry,
        maxAttempts: enrichment.maxAttempts,
        limit: 5,
      })
      const fresh = entries.filter((e) => e.state === "New").length - plan.skip.length
      return {
        imported: counts.Imported,
        /** 取り込み対象 (取り込み済み + これから)。見送り・掲載落ちは数えない */
        eligible: counts.Imported + Math.max(0, fresh),
        next: plan.importNow.map((e) => ({ name: e.name, itemCount: e.itemCount })),
      }
    }),
  ),
)

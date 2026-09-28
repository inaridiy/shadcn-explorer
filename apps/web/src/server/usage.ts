import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import { monthStart, toUsd, type MicroUsd } from "@shadcn-explorer/core/domain"
import { usageByCategory } from "~/infrastructure/d1-repositories"
import { runAppOrThrow } from "~/lib/runtime"

/** 当月のコスト (カテゴリ別) と予算。読み取り専用のクエリなので D1 を直接読む (CQRS の read side) */
export const usageSummaryFn = createServerFn({ method: "GET" }).handler(async () => {
  const since = monthStart(Date.now())
  const rows = await runAppOrThrow(usageByCategory(env.DB, since))
  const total = rows.reduce((s, r) => s + r.total, 0)
  return {
    since,
    budgetUsd: Number(env.MONTHLY_BUDGET_USD) || 100,
    totalUsd: toUsd(total as MicroUsd),
    categories: rows.map((r) => ({ category: r.category, usd: toUsd(r.total as MicroUsd), count: r.n })),
  }
})

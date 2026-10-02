import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"
import { Effect, Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { ComponentId, RegistryId, usageByGroup } from "@shadcn-explorer/core/domain"
import { ExplorerConfig, UsageLedger } from "@shadcn-explorer/core/ports"
import { d1 } from "~/infrastructure/d1"
import { runApp } from "~/lib/runtime"
import { requireAdmin } from "./auth.server"
import { toResult } from "./result"
import { validateWith } from "./validate"

/**
 * 運営者の画面 (/admin) のライフサイクル操作 (v0.7)。
 * 公式ディレクトリの取り込み状況、申請 (GitHub Issues)、作り直し。どれも運営者だけ
 */

/** 公式ディレクトリの取り込み状況 (件数と、次に取り込むもの・見送ったもの) */
export const directoryStatusFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin()
  return toResult(
    await runApp(
      Effect.map(Application.directoryStatus, ({ entries, counts }) => {
        const byRanking = [...entries].sort((a, b) => (b.rankingScore ?? 0) - (a.rankingScore ?? 0))
        const view = (e: (typeof entries)[number]) => ({
          name: e.name,
          url: e.url,
          state: e.state,
          rankingScore: e.rankingScore,
          healthStatus: e.healthStatus,
          itemCount: e.itemCount,
          registryId: e.registryId,
          skipReason: e.skipReason,
          attempts: e.attempts,
        })
        return {
          counts,
          next: byRanking.filter((e) => e.state === "New").slice(0, 10).map(view),
          skipped: byRanking.filter((e) => e.state === "Skipped").map(view),
        }
      }),
    ),
  )
})

/** ディレクトリを読み直して、今すぐ 1 回分取り込む (cron を待たない) */
export const runDirectoryIntakeFn = createServerFn({ method: "POST" }).handler(async () => {
  await requireAdmin()
  return toResult(
    await runApp(
      Effect.map(Effect.zip(Application.syncDirectory, Application.intakeDirectory), ([sync, intake]) => ({ sync, intake })),
    ),
  )
})

/** 見送ったものをもう一度候補に戻す */
export const retryDirectoryEntryFn = createServerFn({ method: "POST" })
  .validator(validateWith(Schema.Struct({ name: Schema.String.pipe(Schema.maxLength(200)) })))
  .handler(async ({ data }) => {
    await requireAdmin()
    return toResult(await runApp(Effect.map(Application.retryDirectoryEntry(data.name), (e) => e._tag === "Some")))
  })

const Scope = Schema.Literal("docs", "previews", "all")

/** 作り直す (レジストリ全体 / 1 コンポーネント × ドキュメント / プレビュー / 両方) */
export const regenerateFn = createServerFn({ method: "POST" })
  .validator(
    validateWith(
      Schema.Struct({
        registryId: RegistryId,
        name: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
        scope: Scope,
      }),
    ),
  )
  .handler(async ({ data }) => {
    await requireAdmin()
    const target = data.name
      ? { componentId: ComponentId.make(`${data.registryId}:${data.name}`) }
      : { registryId: data.registryId }
    return toResult(await runApp(Application.regenerate(target, data.scope)))
  })

interface GitHubIssue {
  readonly number: number
  readonly title: string
  readonly html_url: string
  readonly body: string | null
  readonly created_at: string
  readonly user: { readonly login: string } | null
  readonly pull_request?: unknown
}

/**
 * 申請 (GitHub Issues の registry-request、開いているもの)。Issue Form の「Registry」欄を取り出して取り込み画面に渡す。
 * GitHub の API は匿名だと 60 回/時なので、5 分キャッシュする (GITHUB_TOKEN があれば認証付き)
 */
export const registryRequestsFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin()
  const url = "https://api.github.com/repos/inaridiy/shadcn-explorer/issues?labels=registry-request&state=open&per_page=30"
  const cache = (caches as unknown as { default: Cache }).default
  const cached = await cache.match(url).catch(() => undefined)
  const response =
    cached ??
    (await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "shadcn-explorer",
        ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
    }))
  if (!response.ok) return { ok: false as const, error: `GitHub API: HTTP ${response.status}`, requests: [] }
  if (!cached) {
    const copy = new Response(response.clone().body, { headers: { "cache-control": "public, max-age=300", "content-type": "application/json" } })
    await cache.put(url, copy).catch(() => undefined)
  }
  const issues = (await response.json()) as ReadonlyArray<GitHubIssue>
  return {
    ok: true as const,
    requests: issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        // Issue Form は "### Registry\n\n{値}" の形で本文に入る
        registry: /###\s*Registry\s*\n+([^\n]+)/.exec(i.body ?? "")?.[1]?.trim() ?? null,
        author: i.user?.login ?? null,
        createdAt: i.created_at,
      })),
    email: env.REGISTRY_REQUEST_EMAIL ?? null,
  }
})

/**
 * 管理画面の上段に出す運用の状態: 今日 (UTC) の無料枠の使用量 (群ごと)、ライフサイクルの設定、レジストリ別の Live の件数。
 * 読み取りだけ。無料枠は 00:00 UTC にリセットされるので、その時刻からの合計を数える
 */
export const lifecycleOverviewFn = createServerFn({ method: "GET" }).handler(async () => {
  await requireAdmin()
  const now = Date.now()
  const utcDayStart = now - (now % 86_400_000)
  return toResult(
    await runApp(
      Effect.gen(function* () {
        const config = yield* ExplorerConfig
        const tokens = yield* (yield* UsageLedger).tokensByModelSince(utcDayStart)
        const used = usageByGroup(config.llm, tokens)
        const live = yield* d1("count live previews", () =>
          env.DB.prepare(`select registry_id, count(*) as n from components where preview_tag = 'Captured' group by registry_id`).all<{
            registry_id: string
            n: number
          }>(),
        )
        return {
          now,
          freeQuota: {
            useRatio: config.llm.useRatio,
            overflow: config.llm.overflow._tag,
            groups: config.llm.quotas.map((g) => ({
              name: g.name,
              models: g.models,
              dailyTokens: g.dailyTokens,
              usedTokens: used.get(g.name) ?? 0,
            })),
          },
          lifecycle: {
            directoryIntake: config.lifecycle.directoryIntake,
            intakePerRun: config.lifecycle.intakePerRun,
            maxBacklog: config.lifecycle.maxBacklog,
            resyncIntervalMs: config.lifecycle.resyncIntervalMs,
            maxItemsPerRegistry: config.budget.maxItemsPerRegistry,
            softLimitRatio: config.budget.softLimitRatio,
          },
          liveByRegistry: Object.fromEntries(live.results.map((r) => [r.registry_id, r.n])) as Record<string, number>,
        }
      }),
    ),
  )
})

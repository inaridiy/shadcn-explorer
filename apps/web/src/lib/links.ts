/**
 * GitHub Issues への導線。ラベルは Issue Form 側 (.github/ISSUE_TEMPLATE/*.yml) で付く
 * (URL の labels= は Issue を作る人に triage 権限が無いと効かないため)。入力欄は id をクエリで埋める
 */
const ISSUES = "https://github.com/inaridiy/shadcn-explorer/issues/new"

const issueUrl = (template: string, fields: Record<string, string | undefined>) => {
  const params = new URLSearchParams({ template })
  for (const [key, value] of Object.entries(fields)) if (value) params.set(key, value.slice(0, 500))
  return `${ISSUES}?${params.toString()}`
}

/** レジストリ追加の申請 (registry-request.yml) */
export const REGISTRY_REQUEST_URL = issueUrl("registry-request.yml", {})

/** プレビューの不具合 (preview-report.yml、ラベル preview-broken) */
export const previewReportUrl = (args: { readonly registryId: string; readonly name: string; readonly pageUrl?: string; readonly build?: string }) =>
  issueUrl("preview-report.yml", {
    title: `[Preview] ${args.registryId}/${args.name}`,
    component: `${args.registryId}/${args.name}`,
    page: args.pageUrl,
    build: args.build,
  })

/** テーマの判定の誤り (theme-report.yml、ラベル theme-wrong) */
export const themeReportUrl = (args: { readonly registry: string; readonly pageUrl?: string; readonly detected?: string }) =>
  issueUrl("theme-report.yml", {
    title: `[Theme] ${args.registry}`,
    registry: args.registry,
    page: args.pageUrl,
    detected: args.detected,
  })

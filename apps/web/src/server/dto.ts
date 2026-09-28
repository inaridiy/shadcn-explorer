import { Option } from "effect"
import type { Application } from "@shadcn-explorer/core"
import type { ComponentKind, Registry } from "@shadcn-explorer/core/domain"
import type { ComponentRecord } from "@shadcn-explorer/core/ports"

/**
 * プレゼンテーション層の DTO。ドメインオブジェクト (クラス・ブランド型) をそのまま外に出さず、
 * server fn / REST / MCP で共通のプレーンな JSON に写す。
 */

export const mediaUrl = (key: string) => `/media/${key}`

export interface ComponentCardDto {
  readonly id: string
  readonly registryId: string
  readonly name: string
  readonly kind: ComponentKind
  readonly title: string
  readonly description: string
  readonly summary: string | null
  readonly screenshot: { readonly light: string; readonly dark: string | null } | null
  readonly status: { readonly doc: string; readonly preview: string; readonly index: string }
}

export const toCard = (record: ComponentRecord): ComponentCardDto => {
  const { snapshot, doc, enrichment } = record
  const preview = enrichment.preview
  return {
    id: snapshot.id,
    registryId: snapshot.registryId,
    name: snapshot.name,
    kind: snapshot.kind,
    title: snapshot.title,
    description: snapshot.description,
    summary: Option.getOrNull(Option.map(doc, (d) => d.summary)),
    screenshot:
      preview._tag === "Captured"
        ? { light: mediaUrl(preview.lightKey), dark: preview.darkKey ? mediaUrl(preview.darkKey) : null }
        : null,
    status: { doc: enrichment.doc._tag, preview: preview._tag, index: enrichment.index._tag },
  }
}

export interface SearchHitDto extends ComponentCardDto {
  readonly score: number
  readonly sources: ReadonlyArray<string>
}

export const toSearchResultDto = (result: Application.SearchResult) => ({
  hits: result.hits.map((h): SearchHitDto => ({ ...toCard(h.record), score: h.score, sources: h.sources })),
  warnings: result.warnings,
})

export interface RegistryDto {
  readonly id: string
  readonly name: string
  readonly homepage: string | null
  readonly namespace: string | null
  readonly indexUrl: string
  readonly status: Registry["status"]
  readonly componentCount: number
  readonly createdAt: number
}

export const toRegistryDto = (registry: Registry, componentCount = 0): RegistryDto => ({
  id: registry.id,
  name: registry.name,
  homepage: registry.homepage,
  namespace: registry.namespace,
  indexUrl: registry.locator.indexUrl,
  status: registry.status,
  componentCount,
  createdAt: registry.createdAt,
})

export const toDetailDto = (detail: Application.ComponentDetail) => {
  const { record, registry } = detail
  const { snapshot, enrichment } = record
  const doc = Option.getOrNull(record.doc)
  return {
    ...toCard(record),
    registry: toRegistryDto(registry),
    installCommand: detail.installCommand,
    sourceUrl: snapshot.sourceUrl,
    dependencies: snapshot.dependencies,
    devDependencies: snapshot.devDependencies,
    registryDependencies: snapshot.registryDependencies,
    categories: snapshot.categories,
    files: snapshot.files,
    previewHtmlUrl:
      enrichment.preview._tag === "Captured" && enrichment.preview.htmlKey ? mediaUrl(enrichment.preview.htmlKey) : null,
    doc: doc
      ? {
          summary: doc.summary,
          visualDescription: doc.visualDescription,
          whenToUse: doc.whenToUse,
          usage: doc.usage,
          examples: doc.examples,
          props: doc.props,
          accessibility: doc.accessibility,
          agentPrompt: doc.agentPrompt,
          keywords: doc.keywords,
        }
      : null,
    docError: enrichment.doc._tag === "Failed" ? enrichment.doc.error : null,
    related: detail.related.map(toCard),
  }
}
export type ComponentDetailDto = ReturnType<typeof toDetailDto>

/** Agent 向けの Markdown (MCP / "Copy for agent" ボタンで使う) */
export const toAgentMarkdown = (d: ComponentDetailDto): string => {
  const lines = [
    `# ${d.title} (${d.registryId}/${d.name})`,
    "",
    d.doc?.summary ?? d.description,
    "",
    "## Install",
    "```bash",
    d.installCommand,
    "```",
  ]
  if (d.doc) {
    lines.push("", "## Usage", "```tsx", d.doc.usage, "```")
    for (const ex of d.doc.examples) lines.push("", `### ${ex.title}`, ex.description, "```tsx", ex.code, "```")
    if (d.doc.props.length > 0) {
      lines.push("", "## Props", "| name | type | default | description |", "| --- | --- | --- | --- |")
      for (const p of d.doc.props) lines.push(`| ${p.name} | \`${p.type}\` | ${p.default ?? ""} | ${p.description} |`)
    }
  }
  if (d.dependencies.length > 0) lines.push("", `Dependencies: ${d.dependencies.join(", ")}`)
  return lines.join("\n")
}

import { Schema } from "effect"
import type { ComponentKind } from "./component.js"

/**
 * プレビューのデモ (= ui.shadcn.com のドキュメント冒頭にあるインタラクティブなデモ)。
 *
 * LLM が書くのは `src/demo.tsx` 1 ファイルだけ。枠 (#preview の余白・中央寄せ・テーマ切り替え) は
 * 信頼できるハーネス側が持ち、LLM には決めさせない。これが「ランディングページ風のサムネイル」を防ぐ要。
 */
export const DemoLayout = Schema.Literal("centered", "fullwidth")
export type DemoLayout = typeof DemoLayout.Type

/** ブロック・ページは全幅で上から、それ以外は docs と同じ中央寄せの枠に置く (モデルに選ばせない) */
export const demoLayoutOf = (kind: ComponentKind): DemoLayout => (kind === "block" || kind === "page" ? "fullwidth" : "centered")

export const PreviewDemo = Schema.Struct({
  code: Schema.String,
  layout: DemoLayout,
})
export type PreviewDemo = typeof PreviewDemo.Type

/**
 * プレビューの生成方式の版。ビルドと撮影で分ける (撮影だけの変更で LLM とコンテナを払い直さないため)。
 * - BUILD_VERSION: ハーネス・デモのプロンプト・ビルド手順を変えたら上げる。全件がデモ生成からやり直しになる
 * - CAPTURE_VERSION: 撮影方法 (ビューポート・動くサムネイル) を変えたら上げる。既存の HTML を撮り直すだけ
 * 旧名 PREVIEW_VERSION ("demo-v2") の値をそのまま BUILD_VERSION に引き継いでいる (作り直しを起こさないため)。
 */
export const BUILD_VERSION = "demo-v2"
export const CAPTURE_VERSION = "cap-v8"

/**
 * プレビュー成果物の鮮度キー。ソースのハッシュとビルド方式の版の組。
 * R2 のキーにも入るので、作り直した HTML / PNG が古いキャッシュと混ざらない。
 */
export const previewSourceHash = (contentHash: string, version: string): string =>
  version === "" ? contentHash : `${contentHash}.${version}`

/**
 * プレビューが失敗した原因。再試行・エージェントへの委譲・UI の出し分けが全部これで決まる。
 * - registry: アイテムが公開されたままではインストール・ビルドできない (アイテムが変わるまで再試行しない)
 * - demo:     生成したデモが悪い (修正を使い切った)
 * - harness:  こちらのハーネスのバグ (BUILD_VERSION を上げるまで再試行しない)
 * - infra:    LLM・コンテナ・ブラウザの一時障害 (再試行する)
 */
export const PreviewFailureCause = Schema.Literal("registry", "demo", "harness", "infra")
export type PreviewFailureCause = typeof PreviewFailureCause.Type

/** どちらがビルド手順を書いたか。agent = 決まった手順で失敗した後、フォールバックの Coding Agent が manifest を書いた */
export const BuildKind = Schema.Literal("core", "agent")
export type BuildKind = typeof BuildKind.Type

/**
 * フォールバックの Coding Agent が返すビルド手順 (manifest)。HTML ではなくデータで受け取り、こちらのコンテナで
 * 決定的に再実行する。操作は許可リスト制で、どれも理由を持つ。ハーネスの run-job.mjs も同じ検証をする。
 */
const reason = { reason: Schema.optional(Schema.String) }
export const ManifestAction = Schema.Union(
  Schema.Struct({ type: Schema.Literal("pin"), package: Schema.String, version: Schema.String, ...reason }),
  Schema.Struct({ type: Schema.Literal("add"), package: Schema.String, version: Schema.String, ...reason }),
  Schema.Struct({ type: Schema.Literal("addItem"), spec: Schema.String, ...reason }),
  Schema.Struct({ type: Schema.Literal("writeFile"), path: Schema.String, content: Schema.String, ...reason }),
  Schema.Struct({ type: Schema.Literal("alias"), specifier: Schema.String, file: Schema.String, ...reason }),
  Schema.Struct({ type: Schema.Literal("wrap"), file: Schema.String, ...reason }),
)
export type ManifestAction = typeof ManifestAction.Type
export const BuildManifest = Schema.Struct({ actions: Schema.Array(ManifestAction) })
export type BuildManifest = typeof BuildManifest.Type

const PKG = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^[0-9A-Za-z.^~<>=|* -]{1,40}$/
const ITEM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|https:\/\/[^\s"'`]{1,300}\.json)$/
const COMPAT_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}\.(tsx|ts|jsx|js|css)$/
const compatFile = (f: string) => COMPAT_FILE.test(f) && !f.split("/").includes("..")

/** manifest の検査 (ハーネスと同じ規則)。空配列 = 合格 */
export const validateManifest = (manifest: BuildManifest): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const packages = manifest.actions.filter((a) => a.type === "pin" || a.type === "add")
  const writes = manifest.actions.filter((a) => a.type === "writeFile")
  if (packages.length > 5) problems.push("at most 5 package actions (pin/add)")
  if (writes.length > 10) problems.push("at most 10 writeFile actions")
  for (const a of manifest.actions) {
    const ok =
      a.type === "pin" || a.type === "add"
        ? PKG.test(a.package) && VERSION.test(a.version)
        : a.type === "addItem"
          ? ITEM_SPEC.test(a.spec)
          : a.type === "writeFile"
            ? compatFile(a.path) && a.content.length <= 200_000
            : a.type === "alias"
              ? /^[a-z@][a-zA-Z0-9@._/-]{0,120}$/.test(a.specifier) && compatFile(a.file)
              : compatFile(a.file)
    if (!ok) problems.push(`invalid ${a.type} action`)
  }
  return problems
}

const MAX_LINES = 80

const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/<h[1-3][\s>]/, "Do not add headings (<h1>-<h3>): the demo is the component itself, not a page about it."],
  [/<(header|nav|footer|main)[\s>]/, "Do not add page chrome (<header>/<nav>/<footer>/<main>)."],
  [/\b(dark ?mode|theme ?toggle|toggleTheme|setTheme)\b/i, "Do not add a theme toggle: the harness controls light/dark."],
  [/\bMath\.random\s*\(|\bDate\.now\s*\(|new Date\(\s*\)/, "Do not use Math.random/Date.now/new Date(): previews must be deterministic."],
  [/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/, "Do not make network requests: the preview runs offline."],
  [/["'`]https?:\/\//, "Do not reference remote URLs (images, fonts, APIs): the preview runs offline. Use initials/icons/inline SVG instead."],
  [/\b(localStorage|sessionStorage|document\.cookie)\b/, "Do not use browser storage."],
  [/\bdocument\.(body|documentElement|querySelector|getElementById)/, "Do not touch the document outside the demo."],
  [/\bmin-h-screen\b|\bh-screen\b|\bmin-h-svh\b/, "Do not use screen-height sizing; the harness frame sizes the demo."],
]

const stripExt = (p: string) => p.replace(/\.(tsx|ts|jsx|js)$/, "")
const basename = (p: string) => p.split("/").pop() ?? p

/**
 * `shadcn add` 後にアイテムのファイルを import するパスの推定 (target があればそれ、無ければ type ごとの既定の置き場所)。
 * 外れていてもビルドエラーと「実際に入ったファイル」の一覧が修正ターンに渡る。
 */
export const importPathOf = (file: { readonly path: string; readonly type?: string; readonly target?: string }): string | null => {
  if (!/\.(tsx|ts|jsx|js)$/.test(file.path)) return null
  if (file.target) return `@/${stripExt(file.target.replace(/^~\//, "").replace(/^src\//, ""))}`
  const name = stripExt(basename(file.path))
  switch (file.type) {
    case "registry:ui":
      return `@/components/ui/${name}`
    case "registry:hook":
      return `@/hooks/${name}`
    case "registry:lib":
      return `@/lib/${name}`
    case "registry:page":
    case "registry:file":
      return null
    default:
      return `@/components/${name}`
  }
}

/** registry-item.json (信頼できない JSON) から、デモが import すべきパスの一覧を取り出す */
export const itemImportPaths = (itemJson: unknown): ReadonlyArray<string> => {
  const files = (itemJson as { files?: unknown } | null)?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((f: { path?: unknown; type?: unknown; target?: unknown }) => {
    if (typeof f?.path !== "string") return []
    const p = importPathOf({
      path: f.path,
      ...(typeof f.type === "string" ? { type: f.type } : {}),
      ...(typeof f.target === "string" ? { target: f.target } : {}),
    })
    return p === null ? [] : [p]
  })
}

/**
 * 生成されたデモの決定的な検査 (コンテナを使う前に弾く)。問題があれば修正指示を返す。空配列 = 合格。
 * `itemImports` を渡すと、デモがアイテム自身を使っているかも検査する
 * (ビルドエラーの修正で、アイテムの代わりに素の shadcn 部品に差し替える「ずる」を防ぐ)。
 */
export const lintDemo = (code: string, itemImports: ReadonlyArray<string> = []): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const imported = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => stripExt(m[1]!))
  if (itemImports.length > 0 && !itemImports.some((p) => imported.includes(p))) {
    problems.push(
      `The demo must import and render the registry item itself from one of: ${itemImports.join(", ")}. Do not replace it with a plain shadcn/ui component.`,
    )
  }
  if (!/export\s+default\s+function\s+\w*\s*\(/.test(code)) {
    problems.push("The file must `export default function Demo()`.")
  }
  if (/```/.test(code)) problems.push("Return only TSX source, without markdown code fences.")
  const lines = code.trim().split("\n").length
  if (lines > MAX_LINES) problems.push(`The demo has ${lines} lines; keep it under ${MAX_LINES}. Show one representative use, not a gallery.`)
  for (const [re, message] of BANNED) if (re.test(code)) problems.push(message)
  return problems
}

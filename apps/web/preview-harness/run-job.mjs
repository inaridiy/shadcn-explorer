#!/usr/bin/env node
/**
 * Preview build job (trusted code; the registry item, the demo and a build manifest are not).
 *
 *   node run-job.mjs <job.json> <out.html>
 *     → prints one JSON line: { ok, stage, cause?, errors, workarounds, files }; on success the HTML is copied to <out.html>
 *   The harness directory is shared, so concurrent callers must serialize (the container adapter uses flock).
 *
 * job.json:
 *   item        registry-item.json (untrusted)
 *   namespace   the item's own registry namespace ("@8bitcn") or null
 *   registries  { "@ns": "https://.../{name}.json" } for every known registry (resolves registryDependencies)
 *   registry    the registry's preview config (data, operator-approved): { themeCss?, baseItems?, pins?, themeVars?, fonts?, css?,
 *               tokens? } — the theme parts are validated again here (theme-tokens.mjs)
 *   manifest    optional build recipe from the fallback coding agent: { actions: [...] } (allowlisted, validated here)
 *   demo        { code, layout }
 *
 * The deterministic core stays small on purpose. Anything item-specific beyond it is expressed as manifest data
 * (written by the fallback agent, labelled in the UI), not as new branches here. Every deviation from a plain
 * `shadcn add` is reported in `workarounds` so it is visible and measurable.
 *
 * Failure causes: "registry" (the item cannot be installed/built as published), "demo" (the generated demo is wrong),
 * "harness" (our code). The caller decides retries and escalation from it.
 */
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fontImports, isAllowedCss, themeVarsCss, tokensCss } from "./theme-tokens.mjs"

const HARNESS = path.dirname(new URL(import.meta.url).pathname)
const job = JSON.parse(readFileSync(process.argv[2], "utf8"))
const outPath = process.argv[3]
const bin = (name) => path.join(HARNESS, "node_modules/.bin", name)

const MAX_LOG = 6_000
const tail = (s) => (s.length > MAX_LOG ? `…${s.slice(-MAX_LOG)}` : s)
const run = (cmd, args, timeoutMs) => {
  const r = spawnSync(cmd, args, {
    cwd: HARNESS,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, CI: "1", npm_config_ignore_scripts: "true", NO_COLOR: "1", FORCE_COLOR: "0" },
    maxBuffer: 32 * 1024 * 1024,
  })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "")
  return { ok: r.status === 0, out: r.error ? `${out}\n${r.error.message}` : out }
}
const workarounds = []
let files = []
const finish = (result) => {
  process.stdout.write(`${JSON.stringify({ ...result, workarounds, files })}\n`)
  process.exit(0)
}
const fail = (stage, cause, errors) => finish({ ok: false, stage, cause, errors })

// ---------------------------------------------------------------------------
// Validation of untrusted structured input (the manifest and registry config)
// ---------------------------------------------------------------------------
const PKG = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const VERSION = /^[0-9A-Za-z.^~<>=|* -]{1,40}$/
const ITEM_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|https:\/\/[^\s"'`]{1,300}\.json)$/
const COMPAT_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}\.(tsx|ts|jsx|js|css)$/
const MAX_PACKAGES = 5
const MAX_FILES = 10
const MAX_FILE_BYTES = 200_000

const validateManifest = (manifest) => {
  const actions = Array.isArray(manifest?.actions) ? manifest.actions : []
  const problems = []
  const packages = actions.filter((a) => a?.type === "pin" || a?.type === "add")
  const writes = actions.filter((a) => a?.type === "writeFile")
  if (packages.length > MAX_PACKAGES) problems.push(`at most ${MAX_PACKAGES} package actions`)
  if (writes.length > MAX_FILES) problems.push(`at most ${MAX_FILES} files`)
  for (const a of actions) {
    const compat = (f) => typeof f === "string" && COMPAT_FILE.test(f) && !f.split("/").includes("..")
    const ok =
      ((a?.type === "pin" || a?.type === "add") && PKG.test(a.package ?? "") && VERSION.test(a.version ?? "")) ||
      (a?.type === "addItem" && ITEM_SPEC.test(a.spec ?? "")) ||
      (a?.type === "writeFile" && compat(a.path) && typeof a.content === "string" && a.content.length <= MAX_FILE_BYTES) ||
      (a?.type === "alias" && /^[a-z@][a-zA-Z0-9@._/-]{0,120}$/.test(a.specifier ?? "") && compat(a.file)) ||
      (a?.type === "wrap" && compat(a.file))
    if (!ok) problems.push(`invalid action: ${JSON.stringify(a).slice(0, 200)}`)
  }
  return { actions, problems }
}
const manifest = validateManifest(job.manifest)
if (manifest.problems.length > 0) fail("install", "demo", [`manifest rejected: ${manifest.problems.join("; ")}`])
const config = job.registry ?? {}
const baseItems = (Array.isArray(config.baseItems) ? config.baseItems : []).filter((s) => ITEM_SPEC.test(s)).slice(0, 10)
const registryPins = Object.entries(config.pins ?? {}).filter(([p, v]) => PKG.test(p) && VERSION.test(String(v))).slice(0, 20)

// ---------------------------------------------------------------------------
// 1. Reset to the pristine snapshot. `pnpm install --frozen-lockfile` prunes packages an earlier job added, so a
//    build never depends on which container (and which job history) it lands on.
// ---------------------------------------------------------------------------
run("git", ["checkout", "-q", "--", "."], 30_000)
run("git", ["clean", "-fdxq", "-e", "node_modules", "-e", ".tsbuildinfo", "-e", ".harness-version"], 30_000)
const pruned = run("pnpm", ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], 180_000)
if (!pruned.ok) run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], 180_000)

const components = JSON.parse(readFileSync(path.join(HARNESS, "components.json"), "utf8"))
components.registries = { ...(components.registries ?? {}), ...(job.registries ?? {}) }
writeFileSync(path.join(HARNESS, "components.json"), JSON.stringify(components, null, 2))

// Transient network failures (resets, timeouts, DNS) are not the registry's fault: retry, and if they persist report
// them as "infra" so the job is retried later instead of being marked "cannot be built as published"
const NETWORK_ERROR = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network (error|timeout)|ERR_SOCKET|UND_ERR/i
const isNetworkError = (out) => NETWORK_ERROR.test(out)
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const withRetry = (attempt) => {
  let r = attempt()
  for (let i = 1; i <= 2 && !r.ok && isNetworkError(r.out); i++) {
    pause(2000 * i)
    r = attempt()
  }
  return r
}
const installCause = (out, fallback) => (isNetworkError(out) ? "infra" : fallback)

const shadcnAdd = (target, overwrite = true) =>
  withRetry(() => run(bin("shadcn"), ["add", target, "--yes", ...(overwrite ? ["--overwrite"] : []), "--silent"], 180_000))
const pnpmAdd = (specs) => withRetry(() => run("pnpm", ["add", "--prefer-offline", "--ignore-scripts", ...specs], 180_000))

// ---------------------------------------------------------------------------
// 2. Registry-level data: theme tokens, pinned versions (pnpm overrides), base items installed before every item
// ---------------------------------------------------------------------------
// The theme: build-time names (@theme inline → utilities like bg-main), the default token values, extra CSS and fonts,
// then the operator's hand-written themeCss last so it overrides everything. Remote font imports go to a file the demo
// entry imports (Vite transforms it, so inline-fonts.ts embeds the fonts); the rest goes to the file index.css imports
// (Tailwind reads it directly).
{
  const theme = []
  const fonts = fontImports(config.fonts)
  theme.push(themeVarsCss(config.themeVars), tokensCss(config.tokens))
  if (isAllowedCss(config.css)) theme.push(config.css)
  if (typeof config.themeCss === "string" && config.themeCss.trim() !== "") {
    const isFontImport = (l) => /^\s*@import\s+(url\()?\s*["']?https:\/\//.test(l)
    const lines = config.themeCss.slice(0, 200_000).split("\n")
    fonts.push(...lines.filter(isFontImport))
    theme.push(lines.filter((l) => !isFontImport(l)).join("\n"))
  }
  const css = theme.filter((t) => t && t.trim() !== "").join("\n")
  if (css !== "" || fonts.length > 0) {
    writeFileSync(path.join(HARNESS, "src/registry-fonts.css"), fonts.join("\n") + "\n")
    writeFileSync(path.join(HARNESS, "src/registry-theme.css"), css + "\n")
    workarounds.push("registry-theme")
  }
}
const manifestPins = manifest.actions.filter((a) => a.type === "pin").map((a) => [a.package, a.version])
const overrides = [...registryPins, ...manifestPins]
if (overrides.length > 0) {
  // pnpm 11 reads overrides from pnpm-workspace.yaml; every later install resolves these packages to the pinned version
  const lines = overrides.map(([p, v]) => `  ${JSON.stringify(p)}: ${JSON.stringify(String(v))}`)
  writeFileSync(path.join(HARNESS, "pnpm-workspace.yaml"), `packages: []\noverrides:\n${lines.join("\n")}\n`)
  const r = withRetry(() => run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], 180_000))
  if (!r.ok) fail("install", installCause(r.out, manifestPins.length > 0 ? "demo" : "registry"), [tail(r.out)])
  for (const [p, v] of registryPins) workarounds.push(`registry-pin:${p}@${v}`)
  for (const [p, v] of manifestPins) workarounds.push(`pin:${p}@${v}`)
}
for (const spec of baseItems) {
  // A theme item that does not install (gone, or served differently) must not take every preview of the registry down:
  // build with the harness default theme and report it
  const r = shadcnAdd(spec)
  workarounds.push(r.ok ? `registry-base:${spec}` : `registry-base-failed:${spec}`)
}

// ---------------------------------------------------------------------------
// 3. The item itself, from the stored registry-item.json
// ---------------------------------------------------------------------------
const addItem = (item) => {
  writeFileSync("/tmp/registry-item.json", JSON.stringify(item))
  return shadcnAdd("/tmp/registry-item.json")
}
let add = addItem(job.item)
// A bare registryDependency ("health-bar") resolves to the official shadcn registry. When that item does not exist
// there, the registry meant its own sibling: retry once with those dependencies namespaced ("@8bitcn/health-bar").
const notFound = [...add.out.matchAll(/ui\.shadcn\.com\/r\/styles\/[^/]+\/([a-z0-9-]+)\.json was not found/g)].map((m) => m[1])
if (!add.ok && notFound.length > 0 && job.namespace && Array.isArray(job.item.registryDependencies)) {
  const deps = job.item.registryDependencies.map((d) => (notFound.includes(d) ? `${job.namespace}/${d}` : d))
  add = addItem({ ...job.item, registryDependencies: deps })
  if (add.ok) for (const d of notFound) workarounds.push(`namespaced-dependency:${d}`)
}
if (!add.ok) fail("install", installCause(add.out, "registry"), [tail(add.out)])

// What the item actually installed, so a repair turn can fix wrong import paths
const changedFiles = () =>
  run("git", ["status", "--porcelain", "--untracked-files=all", "src"], 30_000)
    .out.split("\n")
    .map((l) => l.slice(3).trim())
    .filter((f) => /\.(tsx?|jsx?)$/.test(f) && f !== "src/demo.tsx" && !f.startsWith("src/compat/"))
files = changedFiles()

// Registries often import sibling items they forgot to list in registryDependencies (an 8-bit calendar importing
// "./button"). Install the same-named item from the item's own namespace, like a user would after the build error.
const EXTS = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"]
const unresolvedSiblings = () => {
  const missing = new Set()
  for (const file of files) {
    const abs = path.join(HARNESS, file)
    if (!existsSync(abs)) continue
    for (const m of readFileSync(abs, "utf8").matchAll(/from\s+["']((?:\.{1,2}\/|@\/)[^"']+)["']/g)) {
      const spec = m[1]
      const base = spec.startsWith("@/") ? path.join(HARNESS, "src", spec.slice(2)) : path.resolve(path.dirname(abs), spec)
      if (!EXTS.some((ext) => existsSync(base + ext))) missing.add(path.basename(spec))
    }
  }
  return [...missing].filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n))
}
const siblings = []
for (let round = 0; round < 2 && job.namespace; round++) {
  const missing = unresolvedSiblings().filter((n) => !siblings.includes(n))
  if (missing.length === 0) break
  for (const name of missing) {
    // One item per call: an unknown name must not abort the others. Never overwrite what the item installed.
    if (shadcnAdd(`${job.namespace}/${name}`, false).ok) {
      siblings.push(name)
      workarounds.push(`sibling-item:${name}`)
    }
  }
  files = changedFiles()
}

// ---------------------------------------------------------------------------
// 4. Build manifest (fallback agent's recipe): extra items, packages, compat files, aliases, provider wrappers
// ---------------------------------------------------------------------------
const compatDir = path.join(HARNESS, "src/compat")
const aliases = {}
const wraps = []
for (const a of manifest.actions) {
  if (a.type === "addItem") {
    const r = shadcnAdd(a.spec, false)
    if (!r.ok) fail("install", "demo", [`manifest addItem ${a.spec}: ${tail(r.out)}`])
    workarounds.push(`item:${a.spec}`)
  } else if (a.type === "add") {
    const r = pnpmAdd([`${a.package}@${a.version}`])
    if (!r.ok) fail("install", "demo", [`manifest add ${a.package}@${a.version}: ${tail(r.out)}`])
    workarounds.push(`add:${a.package}@${a.version}`)
  } else if (a.type === "writeFile") {
    mkdirSync(path.dirname(path.join(compatDir, a.path)), { recursive: true })
    writeFileSync(path.join(compatDir, a.path), a.content)
    workarounds.push(`file:${a.path}`)
  } else if (a.type === "alias") {
    aliases[a.specifier] = a.file
    workarounds.push(`alias:${a.specifier}`)
  } else if (a.type === "wrap") {
    wraps.push(a.file)
    workarounds.push(`wrap:${a.file}`)
  }
}
if (Object.keys(aliases).length > 0) writeFileSync(path.join(compatDir, "aliases.json"), JSON.stringify(aliases))
if (wraps.length > 0) {
  const imports = wraps.map((f, i) => `import W${i} from "./${f.replace(/\.(tsx|ts|jsx|js)$/, "")}"`)
  writeFileSync(
    path.join(compatDir, "index.ts"),
    `import type { ComponentType, ReactNode } from "react"\n${imports.join("\n")}\n\nexport const wrappers: ReadonlyArray<ComponentType<{ children: ReactNode }>> = [${wraps.map((_, i) => `W${i}`).join(", ")}]\n`,
  )
}

// ---------------------------------------------------------------------------
// 5. The demo
// ---------------------------------------------------------------------------
writeFileSync(path.join(HARNESS, "src/demo.tsx"), job.demo.code)
writeFileSync(path.join(HARNESS, "src/preview.json"), JSON.stringify({ layout: job.demo.layout }))

// 6. Bare imports that are not installed (registries often under-declare dependencies)
const BUILTIN = /^(react|react-dom|next)(\/|$)|^node:/
const packageOf = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0])
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f)
    if (statSync(p).isDirectory()) return f === "next-stubs" ? [] : walk(p)
    return /\.(tsx?|jsx?|mjs|css)$/.test(f) ? [p] : []
  })
const missingPackages = () => {
  const wanted = new Set()
  for (const file of walk(path.join(HARNESS, "src"))) {
    const text = readFileSync(file, "utf8")
    for (const m of text.matchAll(/(?:from\s+|import\s*\(?\s*|@import\s+)["']([^"'./@][^"']*|@[^"'/]+\/[^"']+)["']/g)) {
      const spec = m[1]
      if (spec.startsWith("@/") || BUILTIN.test(spec) || /^https?:/.test(spec) || spec in aliases) continue
      const pkg = packageOf(spec)
      if (PKG.test(pkg) && !existsSync(path.join(HARNESS, "node_modules", pkg))) wanted.add(pkg)
    }
  }
  return [...wanted]
}
const installed = []
const install = (pkgs) => {
  if (pkgs.length === 0) return true
  const r = pnpmAdd(pkgs)
  if (r.ok) {
    installed.push(...pkgs)
    for (const p of pkgs) workarounds.push(`undeclared-dependency:${p}`)
  }
  return r.ok
}
install(missingPackages())

// 7. Build. An unresolved import that the scan missed gets one install-and-retry per package.
let build
for (let i = 0; i < 4; i++) {
  build = run(bin("vite"), ["build"], 180_000)
  if (build.ok) break
  const m = build.out.match(/failed to resolve import "([^"]+)"/)
  const pkg = m && !m[1].startsWith(".") && !m[1].startsWith("@/") ? packageOf(m[1]) : null
  if (!pkg || installed.includes(pkg) || !install([pkg])) break
}
const buildErrors = (out) =>
  out
    .split("\n")
    .filter((l) => !/^\s+at /.test(l))
    .join("\n")
    .replaceAll(HARNESS + "/", "")
    .trim()
const installedFiles = `Files installed by shadcn add (import them as "@/..." without "src/" and the extension):\n${files.map((f) => `- ${f}`).join("\n")}`

/**
 * Who is at fault for a build error. A harness file anywhere in the message → "harness". Otherwise the error's own
 * source location (Rolldown's "╭─[ file:line" marker, or any path when there is none) decides: the demo or manifest
 * compat files → "demo"; anything the registry installed → "registry".
 */
const classify = (out) => {
  const PATH = /(src\/[A-Za-z0-9_./@-]+\.(?:tsx?|jsx?|css)|node_modules\/[^\s"':\]]+|vite\.config\.ts|inline-fonts\.ts|next-font-stub\.ts)/
  const all = [...out.matchAll(new RegExp(PATH.source, "g"))].map((m) => m[1])
  const marked = [...out.matchAll(new RegExp(`╭─\\[\\s*${PATH.source}`, "g"))].map((m) => m[1])
  // Any harness file involved (e.g. a stub lacking an export) is our bug, wherever the error is reported
  if (all.some((l) => /^(src\/(main\.tsx|next-stubs\/|index\.css|theme-default\.css)|vite\.config|inline-fonts|next-font-stub)/.test(l))) return "harness"
  const locations = marked.length > 0 ? marked : all
  return locations.some((l) => !/^src\/(demo\.tsx|compat\/|preview\.json)/.test(l)) ? "registry" : "demo"
}
if (!build.ok) {
  const text = buildErrors(build.out)
  fail("build", classify(text), [tail(text), installedFiles])
}

// 8. Runtime check: render the built page in Chromium. A demo that throws is broken; feed the error to the repair loop.
const check = run("node", [path.join(HARNESS, "render.mjs"), "check", path.join(HARNESS, "dist/index.html")], 120_000)
let runtimeErrors = []
try {
  runtimeErrors = JSON.parse(check.out.trim().split("\n").pop()).runtimeErrors ?? []
} catch {
  fail("build", "harness", [`runtime check crashed: ${tail(check.out)}`])
}
if (runtimeErrors.length > 0) {
  fail("build", "demo", [`runtime error when rendering the demo in a browser: ${runtimeErrors.join(" | ")}`, installedFiles])
}

// 9. Type diagnostics for the demo only (type errors inside registry files are not the demo's fault)
const tsc = run(bin("tsc"), ["--noEmit", "-p", "tsconfig.json"], 180_000)
const demoErrors = tsc.ok
  ? []
  : tsc.out
      .split(/\n(?=\S)/)
      .filter((block) => block.startsWith("src/demo.tsx"))
      .slice(0, 20)
copyFileSync(path.join(HARNESS, "dist/index.html"), outPath)
finish({ ok: true, stage: "done", errors: demoErrors.length > 0 ? [...demoErrors, installedFiles] : [] })

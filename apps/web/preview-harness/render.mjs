#!/usr/bin/env node
/**
 * Renders a built preview with Playwright/Chromium inside the container (trusted code; the HTML is not).
 *
 *   node render.mjs check <index.html>
 *     → { runtimeErrors }                 quick smoke test used by run-job.mjs right after the build
 *   node render.mjs capture <index.html> <outDir> <centered|fullwidth> [options.json]
 *     options.json: { tokens?: { light, dark? }, schemes?: ["light"] | ["light", "dark"] }
 *     → { runtimeErrors, shots: [{ scheme, file, embedFile }], motion: [{ scheme, file, durationMs }] | null, durationMs }
 *
 * Capture:
 * - Stills are taken with prefers-reduced-motion: reduce (a calm frame), in a 16:10 viewport (720×450 for components,
 *   1280×800 for blocks/pages; a block that turns out to be a narrow widget is centered by the harness, data-fit).
 *   The viewport, not the element, is captured so Radix portals (open dialogs/popovers) are included.
 *   Chromium's PNG is re-encoded by sharp: a near-lossless WebP for display (about 40 % of the PNG, text stays crisp) and a
 *   JPEG at CSS pixel size for the image embedding (Gemini Embedding 2 accepts only PNG and JPEG).
 * - Motion is measured, not guessed: with no-preference, seven frames 500 ms apart. Moving if two 1 s deltas in a row change
 *   more than 0.3 % of the pixels, or if small changes (0.03 %, a spinner) keep going (short entrance-only and hover-only
 *   animations stay still). Moving components are
 *   recorded per scheme with Playwright's screencast (one video per scheme, started after the scheme switch has
 *   settled; 3 s for a short dense loop, 6 s otherwise) and converted by ffmpeg to an animated WebP: duplicate frames are
 *   dropped (mpdecimate) and idle stretches are shortened to 0.4 s, while moving frames keep their real timing (motion is
 *   never sped up; the live preview runs at the same speed). A single video cut at wall-clock offsets does not
 *   work: its timeline starts at the first painted frame, not at page creation, so the light clip ended in dark frames.
 * - The registry's default theme tokens are injected before anything is captured (theme-tokens.mjs), so a token-only
 *   change of the registry's theme is a re-capture, not a rebuild. A light-only theme is captured in light only.
 * - All network access is blocked; the HTML is self-contained.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { decode } from "fast-png"
import { chromium } from "playwright"
import sharp from "sharp"
import { tokensCss } from "./theme-tokens.mjs"

const [mode, htmlPath, outDir, layoutArg, optionsPath] = process.argv.slice(2)
const rawHtml = readFileSync(htmlPath, "utf8")
const layout = layoutArg === "fullwidth" ? "fullwidth" : "centered"
const options = optionsPath ? JSON.parse(readFileSync(optionsPath, "utf8")) : {}
const injectedCss = tokensCss(options.tokens ?? null)
// The registry's theme tokens go into the document itself (end of <head>, after the build's styles), so they apply from the
// first paint of every load: the stills and the motion recordings, which start at page load
const html = injectedCss === "" ? rawHtml : rawHtml.replace("</head>", `<style id="preview-capture-tokens">${injectedCss}</style></head>`)
/** The recordings navigate to the preview (instead of setContent) so the harness reads ?theme= before its first render */
const PREVIEW_URL = "https://preview.local/"

const VIEWPORTS = { centered: { width: 720, height: 450 }, fullwidth: { width: 1280, height: 800 } }
const MOTION_THRESHOLD = 0.003
const SMALL_MOTION_THRESHOLD = 0.0003
/** A short loop that changes a lot all the time gets 3 s; slower or sparser motion gets 6 s to show a full cycle */
const CLIP_SECONDS = { dense: 3, sparse: 6 }
/** Idle stretches (no frame changed) are shortened to this, so a clip shows more motion without speeding the motion up */
const MAX_IDLE_SECONDS = 0.4

const started = Date.now()
const browser = await chromium.launch({ args: ["--no-sandbox"] })

const newContext = async (options = {}) => {
  const context = await browser.newContext({ viewport: VIEWPORTS[layout], deviceScaleFactor: 2, ...options })
  await context.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()))
  // Registered last, so it takes precedence for the preview itself; everything else stays blocked
  await context.route((url) => url.href.startsWith(PREVIEW_URL), (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }))
  return context
}

/** Loads the page and waits for the harness to be ready; switches to the centered viewport when the harness says so. */
const load = async (page) => {
  await page.setContent(html, { waitUntil: "load", timeout: 20_000 })
  await page.waitForFunction(() => document.documentElement.dataset.previewReady === "1", undefined, { timeout: 5_000 }).catch(() => {})
  await page.evaluate(() => document.fonts.ready).catch(() => {})
  const fit = await page.evaluate(() => document.getElementById("preview")?.dataset.fit ?? null)
  if (layout === "fullwidth" && fit === "centered") await page.setViewportSize(VIEWPORTS.centered)
}

const setScheme = async (page, scheme, reducedMotion) => {
  await page.emulateMedia({ colorScheme: scheme, reducedMotion })
  await page.evaluate((dark) => {
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
  }, scheme === "dark")
}

const runtimeErrorsOf = async (page, pageErrors) => {
  const boundary = await page.evaluate(() => document.documentElement.dataset.previewError ?? null).catch(() => null)
  return [...(boundary ? [boundary] : []), ...pageErrors].map((e) => String(e).slice(0, 500))
}

const changedRatio = (a, b) => {
  const x = decode(a)
  const y = decode(b)
  if (x.width !== y.width || x.height !== y.height) return 1
  const step = x.channels * 2
  let changed = 0
  let total = 0
  for (let i = 0; i + 2 < x.data.length; i += step) {
    total++
    if (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]) > 48) changed++
  }
  return total === 0 ? 0 : changed / total
}

const done = async (result) => {
  await browser.close()
  process.stdout.write(`${JSON.stringify({ ...result, durationMs: Date.now() - started })}\n`)
  process.exit(0)
}

if (mode === "check") {
  const context = await newContext()
  const page = await context.newPage()
  const pageErrors = []
  page.on("pageerror", (e) => pageErrors.push(e))
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await load(page)
  await page.waitForTimeout(800) // effects that throw shortly after mount
  await done({ runtimeErrors: await runtimeErrorsOf(page, pageErrors) })
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true })
const schemes = Array.isArray(options.schemes) && options.schemes.length > 0
  ? ["light", "dark"].filter((s) => options.schemes.includes(s))
  : ["light", "dark"]

// 1. Stills (reduced motion)
const stillContext = await newContext({ reducedMotion: "reduce" })
const stillPage = await stillContext.newPage()
const pageErrors = []
stillPage.on("pageerror", (e) => pageErrors.push(e))
await load(stillPage)
const shots = []
for (const scheme of schemes) {
  await setScheme(stillPage, scheme, "reduce")
  await stillPage.waitForTimeout(400) // transitions, portal placement
  const png = await stillPage.screenshot({ type: "png" })
  // Must differ from the motion clip's `${scheme}.webp` below (until cap-v7 the recording overwrote the still)
  const file = `${scheme}-still.webp`
  const embedFile = `${scheme}.jpg`
  await sharp(png).webp({ nearLossless: true, quality: 60, effort: 4 }).toFile(path.join(outDir, file))
  await sharp(png)
    .resize({ width: stillPage.viewportSize().width })
    .jpeg({ quality: 85, mozjpeg: true })
    .toFile(path.join(outDir, embedFile))
  shots.push({ scheme, file, embedFile })
}
const runtimeErrors = await runtimeErrorsOf(stillPage, pageErrors)
const viewport = stillPage.viewportSize()
await stillContext.close()
if (runtimeErrors.length > 0) await done({ runtimeErrors, shots, motion: null })

// 2. Motion
const videoDir = path.join(outDir, "video")
// Same viewport logic as the stills (load() applies the fit); the videos are recorded at the final viewport size
const motionContext = await newContext({ reducedMotion: "no-preference" })
const page = await motionContext.newPage()
await load(page)
await setScheme(page, "light", "no-preference")
await page.waitForTimeout(500) // let entrance animations finish
// Seven frames 500 ms apart (3 s). Moving if either:
// - large changes 1 s apart twice in a row (text effects, backgrounds; also multi-second effects that then stop), or
// - small changes that keep going: at least 4 of the 6 steps and one of the last two (a spinner, a progress ring).
//   The small threshold is about 100 CSS px of a 720×450 frame, above a blinking caret
const probe = async () => page.screenshot({ scale: "css", type: "png" })
const frames = [await probe()]
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(500)
  frames.push(await probe())
}
const large = changedRatio(frames[0], frames[2]) > MOTION_THRESHOLD && changedRatio(frames[2], frames[4]) > MOTION_THRESHOLD
const small = frames.slice(1).map((frame, i) => changedRatio(frames[i], frame) > SMALL_MOTION_THRESHOLD)
const moving = large || (small.filter(Boolean).length >= 4 && (small[4] || small[5]))
const dense = frames.slice(1).every((frame, i) => changedRatio(frames[i], frame) > MOTION_THRESHOLD)
const clipSeconds = dense ? CLIP_SECONDS.dense : CLIP_SECONDS.sparse

/** Total duration of an animated WebP (sum of the ANMF frame durations, 24-bit little endian at offset 12 of each chunk) */
const webpDurationMs = (file) => {
  const b = readFileSync(file)
  let total = 0
  for (let i = 12; i + 8 <= b.length; ) {
    const size = b.readUInt32LE(i + 4)
    if (b.toString("ascii", i, i + 4) === "ANMF") total += b.readUIntLE(i + 8 + 12, 3)
    i += 8 + size + (size % 2)
  }
  return total
}

let motion = null
if (moving) {
  motion = []
  await page.close()
  for (const scheme of schemes) {
    // A fresh page per scheme, recorded from the load: effects that play once after mount (a text decode, counters) are
    // captured from the start, and the harness renders the right scheme from its first frame (?theme=)
    const recording = await motionContext.newPage()
    await recording.setViewportSize(viewport)
    await recording.emulateMedia({ colorScheme: scheme, reducedMotion: "no-preference" })
    // Start after the response is committed, so the video does not open with the blank page before it
    await recording.goto(`${PREVIEW_URL}?theme=${scheme}`, { waitUntil: "commit" })
    const video = path.join(videoDir, `${scheme}.webm`)
    await recording.screencast.start({ path: video, size: viewport })
    // A little longer than the clip: on stop, Playwright pads the video with about 1 s of the last frame
    await recording.waitForTimeout(clipSeconds * 1000 + 500)
    await recording.screencast.stop()
    await recording.close()
    const file = `${scheme}.webp`
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-t", String(clipSeconds),
        "-i", video,
        // Drop duplicate frames, then cap each remaining gap (an idle stretch) at MAX_IDLE_SECONDS. Gaps while something
        // moves are 1/15 s and stay as they are, so motion keeps its real speed
        "-vf", `fps=15,mpdecimate=hi=256:lo=128:frac=0.001,setpts=if(eq(N\\,0)\\,0\\,PREV_OUTPTS+min(PTS-PREV_INPTS\\,${MAX_IDLE_SECONDS}/TB))`,
        "-vsync", "vfr",
        "-c:v", "libwebp_anim", "-loop", "0", "-q:v", "60", "-compression_level", "4",
        path.join(outDir, file),
      ],
      { timeout: 120_000 },
    )
    motion.push({ scheme, file, durationMs: webpDurationMs(path.join(outDir, file)) })
  }
}
await motionContext.close()
rmSync(videoDir, { recursive: true, force: true })
await done({ runtimeErrors, shots, motion })

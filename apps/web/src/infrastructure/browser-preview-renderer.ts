import { launch } from "@cloudflare/playwright"
import { Effect, Layer } from "effect"
import { type ColorScheme, PreviewRenderer, RenderError } from "@shadcn-explorer/core/ports"

const VIEWPORT = { width: 1280, height: 800 }

/**
 * Cloudflare Browser Rendering (Playwright) でプレビュー HTML を撮影する。
 * - Agent が生成した HTML は外部通信しない自己完結ファイルの想定なので、外部リクエストは全て遮断する
 * - 1 回のブラウザ起動で light/dark を撮り、ブラウザ時間 (課金単位) を節約する
 * - #preview 要素があればその要素だけを撮る
 */
export const BrowserPreviewRenderer = (browserBinding: BrowserRun) =>
  Layer.succeed(PreviewRenderer, {
    capture: (html, schemes) =>
      Effect.tryPromise({
        try: async () => {
          const started = Date.now()
          const browser = await launch(browserBinding)
          try {
            const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
            await context.route("**/*", (route) =>
              route.request().url().startsWith("data:") ? route.continue() : route.abort(),
            )
            const page = await context.newPage()
            await page.setContent(html, { waitUntil: "load", timeout: 20_000 })
            const shots: Array<{ scheme: ColorScheme; png: Uint8Array }> = []
            for (const scheme of schemes) {
              await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" })
              await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), scheme === "dark")
              await page.waitForTimeout(300) // アニメーション・フォントの反映待ち
              const target = page.locator("#preview")
              const buffer = (await target.count()) > 0 ? await target.first().screenshot() : await page.screenshot()
              shots.push({ scheme, png: new Uint8Array(buffer) })
            }
            return { shots, durationMs: Date.now() - started }
          } finally {
            await browser.close()
          }
        },
        catch: (e) => new RenderError({ reason: String(e).slice(0, 500) }),
      }),
  })

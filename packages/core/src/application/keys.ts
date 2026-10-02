import type { ComponentId } from "../domain/index.js"
import type { ColorScheme } from "../ports/index.js"

// ---------------------------------------------------------------------------
// オブジェクトキー (R2)。ハッシュを含めることで古い成果物と混ざらない (= CDN キャッシュも安全)
// ---------------------------------------------------------------------------

const keyBase = (id: ComponentId) => id.replace(":", "/")
/** 同期時に保存する registry-item.json 原本。生成時に再取得しない (レジストリが個別 JSON を配信しない場合もある) */
export const itemSourceKey = (id: ComponentId, hash: string) => `items/${keyBase(id)}/${hash}.json`
export const previewHtmlKey = (id: ComponentId, hash: string) => `previews/${keyBase(id)}/${hash}.html`
/**
 * スクショ (WebP)・埋め込み用 JPEG・動くサムネイルのキー。撮影方式の版と、見た目を決める設定の版 (variant) を入れる。
 * variant はビルド設定 (configHash) とトークン (tokensHash) の組なので、テーマを変えて撮り直すと別のキーになる。
 * これでキーの中身が変わることがなくなり、/media で immutable として配信できる (cap-v8 から。それ以前のキーには variant が無い)
 */
const shotBase = (id: ComponentId, hash: string, captureVersion: string, variant: string | null) =>
  `screenshots/${keyBase(id)}/${hash}.${captureVersion}${variant ? `.${variant}` : ""}`
export const screenshotKey = (id: ComponentId, hash: string, captureVersion: string, scheme: ColorScheme, variant: string | null = null) =>
  `${shotBase(id, hash, captureVersion, variant)}-${scheme}-still.webp`
/** 画像埋め込みの入力 (JPEG)。表示には使わない */
export const embedImageKey = (id: ComponentId, hash: string, captureVersion: string, scheme: ColorScheme, variant: string | null = null) =>
  `${shotBase(id, hash, captureVersion, variant)}-${scheme}.jpg`
/** 動くサムネイル (animated WebP) */
export const motionKey = (id: ComponentId, hash: string, captureVersion: string, scheme: ColorScheme, variant: string | null = null) =>
  `${shotBase(id, hash, captureVersion, variant)}-${scheme}.webp`
/** 撮影の variant: 見た目に効く設定のハッシュ (14 桁) */
export const captureVariant = (context: { readonly configHash: string; readonly tokensHash: string }) =>
  `${context.configHash.slice(0, 7)}${context.tokensHash.slice(0, 7)}`
/** variant 入りの (中身が変わらない) スクショのキーか。/media の immutable 判定に使う */
export const isImmutableShotKey = (key: string) => /^screenshots\/.+\.cap-v\d+\.[0-9a-z]{6,}-(light|dark)/.test(key)

/**
 * フォールバックの Coding Agent が書いたビルド手順。ビルド方式の版ではなくソースのハッシュに紐づけるので、
 * BUILD_VERSION を上げても再利用される (エージェントを呼び直さない)
 */
export const manifestKey = (id: ComponentId, contentHash: string) => `manifests/${keyBase(id)}/${contentHash}.json`

/** 生成したデモのソース (試行ごと)。hash はプレビューの sourceHash (ソース × 生成方式の版) */
export const demoKey = (id: ComponentId, hash: string, attempt: number) => `demos/${keyBase(id)}/${hash}-${attempt}.tsx`

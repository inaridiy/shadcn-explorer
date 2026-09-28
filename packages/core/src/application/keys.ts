import type { ComponentId } from "../domain/index.js"
import type { ColorScheme } from "../ports/index.js"

// ---------------------------------------------------------------------------
// オブジェクトキー (R2)。ハッシュを含めることで古い成果物と混ざらない (= CDN キャッシュも安全)
// ---------------------------------------------------------------------------

const keyBase = (id: ComponentId) => id.replace(":", "/")
/** 同期時に保存する registry-item.json 原本。生成時に再取得しない (レジストリが個別 JSON を配信しない場合もある) */
export const itemSourceKey = (id: ComponentId, hash: string) => `items/${keyBase(id)}/${hash}.json`
export const previewHtmlKey = (id: ComponentId, hash: string) => `previews/${keyBase(id)}/${hash}.html`
export const screenshotKey = (id: ComponentId, hash: string, scheme: ColorScheme) =>
  `screenshots/${keyBase(id)}/${hash}-${scheme}.png`


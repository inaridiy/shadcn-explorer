import { env } from "cloudflare:workers"

const MAX_BYTES = 4 * 1024 * 1024

/**
 * 画像検索用のアップロードを R2 に置く (uploads/ は R2 のライフサイクルルールで 1 日後に削除)。
 * gemini-embedding-2 が受け付ける PNG / JPEG のみ。マジックナンバーで判定する。
 */
export const storeSearchImage = async (
  file: FormDataEntryValue | null,
): Promise<{ ok: true; key: string } | { ok: false; message: string }> => {
  if (!(file instanceof File)) return { ok: false, message: "image ファイルを指定してください" }
  if (file.size > MAX_BYTES) return { ok: false, message: "画像は 4MB 以下にしてください" }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
  if (!isPng && !isJpeg) return { ok: false, message: "PNG または JPEG のみ対応しています" }
  const key = `uploads/${crypto.randomUUID()}.${isPng ? "png" : "jpg"}`
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: isPng ? "image/png" : "image/jpeg" } })
  return { ok: true, key }
}

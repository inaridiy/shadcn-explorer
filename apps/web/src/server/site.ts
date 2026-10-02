import { createServerFn } from "@tanstack/react-start"
import { env } from "cloudflare:workers"

/**
 * スポンサー枠 (v0.7)。ギャラリーの 1 ページに 1 枠だけ、SPONSORED と明示して出す。検索結果には出さない。
 * SPONSOR_SLOT (JSON: {"title","registry","href","image"?}) が無ければ枠ごと出さない
 */
export interface SponsorSlot {
  readonly title: string
  readonly registry: string
  readonly href: string
  readonly image: string | null
}

const parseSponsor = (raw: string | undefined): SponsorSlot | null => {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    if (typeof v.title !== "string" || typeof v.registry !== "string" || typeof v.href !== "string") return null
    if (!/^https:\/\//.test(v.href)) return null
    return { title: v.title, registry: v.registry, href: v.href, image: typeof v.image === "string" && /^https:\/\//.test(v.image) ? v.image : null }
  } catch {
    return null
  }
}

export const sponsorSlotFn = createServerFn({ method: "GET" }).handler(async () => parseSponsor(env.SPONSOR_SLOT))

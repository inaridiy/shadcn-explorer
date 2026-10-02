/** 公開 URL (OGP の画像と URL は絶対 URL で書く必要がある) */
export const SITE_URL = "https://shadcn-explorer.inaridiy.com"

const absolute = (path: string) => (path.startsWith("http") ? path : `${SITE_URL}${path}`)

/**
 * OGP / X カードの meta。TanStack Router は子ルートの同じ name / property で上書きするので、
 * ルートで既定を出し、ページごとに必要なものだけ渡す
 */
export const socialMeta = (args: { readonly title: string; readonly description: string; readonly image: string; readonly path?: string }) => [
  { property: "og:type", content: "website" },
  { property: "og:site_name", content: "Shadcn Explorer" },
  { property: "og:title", content: args.title },
  { property: "og:description", content: args.description },
  { property: "og:image", content: absolute(args.image) },
  ...(args.path ? [{ property: "og:url", content: absolute(args.path) }] : []),
  { name: "twitter:card", content: "summary_large_image" },
  { name: "twitter:title", content: args.title },
  { name: "twitter:description", content: args.description },
  { name: "twitter:image", content: absolute(args.image) },
]

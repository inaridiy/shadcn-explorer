import type { AnchorHTMLAttributes } from "react"

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname?: string }; prefetch?: boolean; replace?: boolean; scroll?: boolean }

export default function Link({ href, prefetch: _p, replace: _r, scroll: _s, ...rest }: Props) {
  return <a href={typeof href === "string" ? href : (href.pathname ?? "#")} {...rest} />
}

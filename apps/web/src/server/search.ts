import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { ComponentKind, RegistryId, SearchMode } from "@shadcn-explorer/core/domain"
import { storeSearchImage } from "~/api/uploads"
import { AppError, runAppOrThrow } from "~/lib/runtime"
import { toSearchResultDto } from "./dto"
import { validateWith } from "./validate"

export const SearchInput = Schema.Struct({
  q: Schema.String.pipe(Schema.maxLength(500)),
  mode: Schema.optionalWith(SearchMode, { default: () => "hybrid" as const }),
  kinds: Schema.optional(Schema.Array(ComponentKind)),
  registries: Schema.optional(Schema.Array(RegistryId)),
})
export type SearchInput = typeof SearchInput.Encoded

/** テキスト検索 (キーワード / 意味 / ビジュアル / ハイブリッド) */
export const searchFn = createServerFn({ method: "GET" })
  .validator(validateWith(SearchInput))
  .handler(async ({ data }) => {
    if (data.q.trim().length === 0) return { hits: [], warnings: [] }
    const result = await runAppOrThrow(
      Application.searchComponents({
        _tag: "Text",
        text: data.q.trim(),
        mode: data.mode,
        filters: {
          ...(data.kinds?.length ? { kinds: data.kinds } : {}),
          ...(data.registries?.length ? { registryIds: data.registries } : {}),
        },
        limit: 40,
      }),
    )
    return toSearchResultDto(result)
  })

/** 画像で検索 (スクショ・デザインカンプを貼って似た見た目のコンポーネントを探す) */
export const searchByImageFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("FormData expected")
    return data
  })
  .handler(async ({ data }) => {
    const stored = await storeSearchImage(data.get("image"))
    if (!stored.ok) throw new AppError({ code: "BAD_REQUEST", message: stored.message, status: 400 })
    const result = await runAppOrThrow(
      Application.searchComponents({ _tag: "Image", imageKey: stored.key, filters: {}, limit: 40 }),
    )
    return toSearchResultDto(result)
  })

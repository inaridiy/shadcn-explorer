import { createServerFn } from "@tanstack/react-start"
import { Effect, Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { ComponentId, ComponentKind, RegistryId } from "@shadcn-explorer/core/domain"
import { runReadOrThrow } from "~/lib/runtime"
import { toCardDto, toDetailDto } from "./dto"
import { validateWith } from "./validate"

export const getComponentFn = createServerFn({ method: "GET" })
  .validator(validateWith(Schema.Struct({ registryId: Schema.String, name: Schema.String })))
  .handler(async ({ data }) =>
    toDetailDto(await runReadOrThrow(Application.getComponentDetail(ComponentId.make(`${data.registryId}:${data.name}`)))),
  )

/** ギャラリー (プレビューのあるものだけ、レジストリをまたいで混ぜた並び)。after は前のページの next */
export const browseComponentsFn = createServerFn({ method: "GET" })
  .validator(
    validateWith(
      Schema.Struct({
        registryIds: Schema.optional(Schema.Array(RegistryId)),
        kinds: Schema.optional(Schema.Array(ComponentKind)),
        motionOnly: Schema.optional(Schema.Boolean),
        officialOnly: Schema.optional(Schema.Boolean),
        after: Schema.optional(Schema.String.pipe(Schema.maxLength(400))),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const page = await runReadOrThrow(
      Application.browseGallery({
        ...(data.registryIds?.length ? { registryIds: data.registryIds } : {}),
        ...(data.kinds?.length ? { kinds: data.kinds } : {}),
        ...(data.motionOnly ? { motionOnly: true } : {}),
        ...(data.officialOnly ? { officialOnly: true } : {}),
        ...(data.after ? { after: data.after } : {}),
        limit: 48,
      }),
    )
    return { cards: page.cards.map(toCardDto), next: page.next }
  })

/**
 * 「よそで似ているもの」(スクショのベクトルが近い、他のレジストリのコンポーネント)。
 * ページの描画を待たせないよう、クライアントが表示後に呼ぶ。おまけの欄なので、失敗は空で返す
 */
export const similarComponentsFn = createServerFn({ method: "GET" })
  .validator(validateWith(Schema.Struct({ registryId: Schema.String, name: Schema.String })))
  .handler(async ({ data }) => {
    const cards = await runReadOrThrow(
      Application.similarComponents(ComponentId.make(`${data.registryId}:${data.name}`), 8).pipe(
        Effect.tapError((e) => Effect.logWarning("similarComponents failed", e)),
        Effect.orElseSucceed(() => []),
      ),
    )
    return cards.map(toCardDto)
  })

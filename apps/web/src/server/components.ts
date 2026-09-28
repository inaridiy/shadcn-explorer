import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { ComponentId, ComponentKind, RegistryId } from "@shadcn-explorer/core/domain"
import { runAppOrThrow } from "~/lib/runtime"
import { toCard, toDetailDto } from "./dto"
import { validateWith } from "./validate"

export const getComponentFn = createServerFn({ method: "GET" })
  .validator(validateWith(Schema.Struct({ registryId: Schema.String, name: Schema.String })))
  .handler(async ({ data }) =>
    toDetailDto(await runAppOrThrow(Application.getComponentDetail(ComponentId.make(`${data.registryId}:${data.name}`)))),
  )

export const browseComponentsFn = createServerFn({ method: "GET" })
  .validator(
    validateWith(
      Schema.Struct({
        registryId: Schema.optional(RegistryId),
        kinds: Schema.optional(Schema.Array(ComponentKind)),
        offset: Schema.optionalWith(Schema.Number, { default: () => 0 }),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const records = await runAppOrThrow(
      Application.browseComponents({
        ...(data.registryId ? { registryId: data.registryId } : {}),
        ...(data.kinds?.length ? { kinds: data.kinds } : {}),
        limit: 48,
        offset: data.offset,
      }),
    )
    return records.map(toCard)
  })

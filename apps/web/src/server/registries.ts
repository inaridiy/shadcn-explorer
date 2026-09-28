import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { RegistryId } from "@shadcn-explorer/core/domain"
import { describeError, runApp, runAppOrThrow } from "~/lib/runtime"
import { toCard, toRegistryDto } from "./dto"
import { requireUserId } from "./auth.server"
import { validateWith } from "./validate"

export const listRegistriesFn = createServerFn({ method: "GET" }).handler(async () => {
  const list = await runAppOrThrow(Application.listRegistries)
  return list.map((r) => toRegistryDto(r.registry, r.componentCount))
})

export const getRegistryFn = createServerFn({ method: "GET" })
  .validator(validateWith(Schema.Struct({ registryId: RegistryId })))
  .handler(async ({ data }) => {
    const [registry, components] = await Promise.all([
      runAppOrThrow(Application.getRegistry(data.registryId)),
      runAppOrThrow(Application.browseComponents({ registryId: data.registryId, limit: 500, offset: 0 })),
    ])
    return { registry: toRegistryDto(registry, components.length), components: components.map(toCard) }
  })

const RegistrationInput = Schema.Struct({ input: Schema.String.pipe(Schema.trimmed(), Schema.maxLength(500)) })

/**
 * 登録フロー Step 1: URL/@namespace を解決し、アイテム数・種別・コスト見積もりを返す。
 * 失敗はフォームに表示したいので throw せず Result で返す。
 */
export const previewRegistrationFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegistrationInput))
  .handler(async ({ data }) => {
    await requireUserId()
    const result = await runApp(Application.previewRegistration(data.input))
    if (result._tag === "Success") return { ok: true as const, preview: result.value }
    return { ok: false as const, error: result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 } }
  })

/** 登録フロー Step 2: 登録して初回同期を開始 */
export const registerRegistryFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegistrationInput))
  .handler(async ({ data }) => {
    const userId = await requireUserId()
    const result = await runApp(Application.registerRegistry(data.input, userId))
    if (result._tag === "Success") return { ok: true as const, registry: toRegistryDto(result.value) }
    return { ok: false as const, error: result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 } }
  })

/** 手動再同期 (登録者のみ) */
export const resyncRegistryFn = createServerFn({ method: "POST" })
  .validator(validateWith(Schema.Struct({ registryId: RegistryId })))
  .handler(async ({ data }) => {
    const userId = await requireUserId()
    await runAppOrThrow(Application.requestResync(data.registryId, userId))
    return { ok: true as const }
  })

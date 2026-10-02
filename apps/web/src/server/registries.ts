import { createServerFn } from "@tanstack/react-start"
import { Schema } from "effect"
import { Application } from "@shadcn-explorer/core"
import { RegistryId, type RegistryListing, RegistryPreviewConfig } from "@shadcn-explorer/core/domain"
import { describeError, runApp, runAppOrThrow, runReadOrThrow } from "~/lib/runtime"
import { toCardDto, toRegistryDto } from "./dto"
import { requireAdmin } from "./auth.server"
import { toResult } from "./result"
import { validateWith } from "./validate"

export const listRegistriesFn = createServerFn({ method: "GET" }).handler(async () => {
  const list = await runReadOrThrow(Application.listRegistries)
  return list.map((r) => toRegistryDto(r.registry, r.componentCount))
})

export const getRegistryFn = createServerFn({ method: "GET" })
  .validator(validateWith(Schema.Struct({ registryId: RegistryId })))
  .handler(async ({ data }) => {
    const [registry, components] = await Promise.all([
      runAppOrThrow(Application.getRegistry(data.registryId)),
      runAppOrThrow(Application.listComponentCards({ registryId: data.registryId, limit: 500, offset: 0 })),
    ])
    return { registry: toRegistryDto(registry, components.length), components: components.map(toCardDto) }
  })

const RegistrationInput = Schema.Struct({ input: Schema.String.pipe(Schema.trimmed(), Schema.maxLength(500)) })

/**
 * 登録フロー Step 1: URL/@namespace を解決し、アイテム数・種別・コスト見積もりを返す。運営者のみ。
 * 失敗はフォームに表示したいので throw せず Result で返す。
 */
export const previewRegistrationFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegistrationInput))
  .handler(async ({ data }) => {
    await requireAdmin()
    const result = await runApp(Application.previewRegistration(data.input))
    if (result._tag === "Success") return { ok: true as const, preview: result.value }
    return { ok: false as const, error: result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 } }
  })

/**
 * 登録フロー Step 2: 登録して初回同期を開始。運営者のみ。
 * 運営者が登録したレジストリは所有者なし (ownerId = null) にする。ユーザー別の月次上限は一般ユーザー向けなので掛からない
 */
const RegisterInput = Schema.Struct({
  ...RegistrationInput.fields,
  /** 公式ディレクトリに載っていなければこの出自になる (載っていれば常に Official) */
  listing: Schema.optionalWith(Schema.Literal("community", "shadcn"), { default: () => "community" as const }),
  requestedVia: Schema.optionalWith(Schema.Literal("github", "email", "operator"), { default: () => "operator" as const }),
  /** 申請の Issue の URL など */
  reference: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
})

export const registerRegistryFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegisterInput))
  .handler(async ({ data }) => {
    await requireAdmin()
    const listing: RegistryListing =
      data.listing === "shadcn"
        ? { _tag: "Shadcn" }
        : { _tag: "Community", requestedVia: data.requestedVia, reference: data.reference ?? null }
    const result = await runApp(Application.registerRegistry(data.input, null, { listing }))
    if (result._tag === "Success") return { ok: true as const, registry: toRegistryDto(result.value) }
    return { ok: false as const, error: result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 } }
  })

/** 手動再同期 (運営者のみ) */
export const resyncRegistryFn = createServerFn({ method: "POST" })
  .validator(validateWith(Schema.Struct({ registryId: RegistryId })))
  .handler(async ({ data }) => {
    await requireAdmin()
    await runAppOrThrow(Application.requestResync(data.registryId))
    return { ok: true as const }
  })

/** レジストリのプレビュー設定 (運営者のみ)。保存するとビジュアルなアイテムのプレビューを作り直す */
export const updateRegistryPreviewConfigFn = createServerFn({ method: "POST" })
  .validator(validateWith(Schema.Struct({ registryId: RegistryId, config: RegistryPreviewConfig })))
  .handler(async ({ data }) => {
    await requireAdmin()
    const result = await runApp(Application.updateRegistryPreviewConfig(data.registryId, data.config))
    if (result._tag === "Success") return { ok: true as const, rebuilding: result.value.rebuilding }
    return { ok: false as const, error: result._tag === "Failure" ? describeError(result.error as never) : { code: "INTERNAL", message: result.message, status: 500 } }
  })

const RegistryIdInput = Schema.Struct({ registryId: RegistryId })

/** テーマの提案を承認して適用する (運営者のみ)。ビジュアルなアイテムをビルドし直す (デモは再利用) */
export const approveThemeFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegistryIdInput))
  .handler(async ({ data }) => {
    await requireAdmin()
    return toResult(await runApp(Application.approveThemeProposal(data.registryId)))
  })

/** テーマの提案を却下する (運営者のみ。neutral のまま確定する) */
export const rejectThemeFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegistryIdInput))
  .handler(async ({ data }) => {
    await requireAdmin()
    return toResult(await runApp(Application.rejectThemeProposal(data.registryId)))
  })

/** テーマを判定し直す (運営者のみ。registry.json → 決まらなければエージェント) */
export const redetectThemeFn = createServerFn({ method: "POST" })
  .validator(validateWith(RegistryIdInput))
  .handler(async ({ data }) => {
    await requireAdmin()
    return toResult(await runApp(Application.requestThemeDetection(data.registryId)))
  })

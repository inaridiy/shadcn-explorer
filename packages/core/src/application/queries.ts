import { Effect, Option } from "effect"
import { type ComponentId, type ComponentKind, type Registry, type RegistryId, installCommand } from "../domain/index.js"
import {
  BlobStore,
  type ComponentCard,
  type ComponentListFilter,
  type ComponentRecord,
  ComponentRepository,
  type GalleryFilter,
  RegistryRepository,
} from "../ports/index.js"
import { ComponentNotFound } from "./enrich-component.js"
import { RegistryNotFoundById } from "./sync-registry.js"

export interface RegistrySummary {
  readonly registry: Registry
  readonly componentCount: number
}

export const listRegistries = Effect.gen(function* () {
  const registries = yield* RegistryRepository
  const components = yield* ComponentRepository
  const [all, counts] = yield* Effect.all([registries.list(), components.countByRegistry()], { concurrency: 2 })
  return all.map((registry): RegistrySummary => ({ registry, componentCount: counts.get(registry.id) ?? 0 }))
})

export const getRegistry = (id: RegistryId) =>
  Effect.gen(function* () {
    const registries = yield* RegistryRepository
    const found = yield* registries.findById(id)
    if (Option.isNone(found)) return yield* new RegistryNotFoundById({ registryId: id })
    return found.value
  })

export interface ComponentDetail {
  readonly record: ComponentRecord
  readonly registry: Registry
  readonly installCommand: string
  /** registryDependencies のうち、同じレジストリ内で解決できるもの */
  readonly related: ReadonlyArray<ComponentCard>
  /** プレビューとしてビルドしたデモのソース (src/demo.tsx)。docs の Code タブにそのまま出す */
  readonly demoCode: Option.Option<string>
}

export const getComponentDetail = (id: ComponentId) =>
  Effect.gen(function* () {
    const components = yield* ComponentRepository
    const found = yield* components.findById(id)
    if (Option.isNone(found)) return yield* new ComponentNotFound({ componentId: id })
    const record = found.value
    const registryId = record.snapshot.registryId
    const relatedIds = record.snapshot.registryDependencies
      .filter((dep) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dep))
      .map((dep) => `${registryId}:${dep}` as ComponentId)
    const preview = record.enrichment.preview
    const demoKey = (preview._tag === "Built" || preview._tag === "Captured") && preview.demoKey ? preview.demoKey : null
    // レジストリ・関連アイテム・デモは互いに独立なので並列に引く (D1 が遠いと直列の往復がそのまま待ち時間になる)
    const [registry, related, demoCode] = yield* Effect.all(
      [
        getRegistry(registryId),
        relatedIds.length > 0 ? components.findCards(relatedIds) : Effect.succeed<ReadonlyArray<ComponentCard>>([]),
        // デモが読めなくてもページは出す (Code タブが使い方の例に戻るだけ)
        demoKey === null
          ? Effect.succeed(Option.none<string>())
          : BlobStore.pipe(
              Effect.flatMap((blobs) => blobs.get(demoKey)),
              Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
              Effect.orElseSucceed(() => Option.none<string>()),
            ),
      ],
      { concurrency: "unbounded" },
    )
    return {
      record,
      registry,
      installCommand: installCommand(record.snapshot, registry.namespace),
      related,
      demoCode,
    } satisfies ComponentDetail
  })

/** カードの一覧 (名前順)。レジストリのページと REST の /components 用 */
export const listComponentCards = (filter: ComponentListFilter) =>
  Effect.flatMap(ComponentRepository, (components) => components.listCards(filter))

/** ギャラリー: プレビューのあるカードを、レジストリをまたいで混ぜた安定した並びで */
export const browseGallery = (filter: GalleryFilter) => Effect.flatMap(ComponentRepository, (components) => components.gallery(filter))

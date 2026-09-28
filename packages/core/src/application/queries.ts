import { Effect, Option } from "effect"
import { type ComponentId, type ComponentKind, type Registry, type RegistryId, installCommand } from "../domain/index.js"
import { type ComponentRecord, ComponentRepository, RegistryRepository } from "../ports/index.js"
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
  readonly related: ReadonlyArray<ComponentRecord>
}

export const getComponentDetail = (id: ComponentId) =>
  Effect.gen(function* () {
    const components = yield* ComponentRepository
    const found = yield* components.findById(id)
    if (Option.isNone(found)) return yield* new ComponentNotFound({ componentId: id })
    const record = found.value
    const registry = yield* getRegistry(record.snapshot.registryId)
    const relatedIds = record.snapshot.registryDependencies
      .filter((dep) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dep))
      .map((dep) => `${registry.id}:${dep}` as ComponentId)
    const related = relatedIds.length > 0 ? yield* components.findMany(relatedIds) : []
    return {
      record,
      registry,
      installCommand: installCommand(record.snapshot, registry.namespace),
      related,
    } satisfies ComponentDetail
  })

export const browseComponents = (params: {
  readonly registryId?: RegistryId
  readonly kinds?: ReadonlyArray<ComponentKind>
  readonly limit: number
  readonly offset: number
}) =>
  Effect.gen(function* () {
    const components = yield* ComponentRepository
    return yield* components.list(params)
  })

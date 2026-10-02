import { Data } from "effect"
import type { RegistryId } from "../domain/index.js"

export class RegistryNotFoundById extends Data.TaggedError("RegistryNotFoundById")<{
  readonly registryId: RegistryId
}> {}

import { Data } from "effect"
import type { RegistryId } from "../domain/index.js"

export class NotRegistryOwner extends Data.TaggedError("NotRegistryOwner")<{
  readonly registryId: RegistryId
}> {}

import { Array as Arr, Data, Effect, Option, Schema } from "effect"
import {
  type RegistryInput,
  RegistryLocator,
  WireDirectory,
  type WireDirectoryEntry,
  type WireRegistryIndex,
  WireRegistryIndex as WireRegistryIndexSchema,
  candidateLocators,
  classifyRegistryInput,
  normalizeDirectory,
} from "../domain/index.js"
import { ExplorerConfig, RegistryFetchError, RegistryHttp } from "../ports/index.js"

export class RegistryNotFound extends Data.TaggedError("RegistryNotFound")<{
  readonly input: string
  readonly tried: ReadonlyArray<string>
}> {}

export class NamespaceNotFound extends Data.TaggedError("NamespaceNotFound")<{
  readonly namespace: string
}> {}

export interface ResolvedRegistry {
  readonly locator: RegistryLocator
  readonly index: WireRegistryIndex
  readonly namespace: string | null
  readonly directoryEntry: Option.Option<WireDirectoryEntry>
}

const decodeIndex = (url: string, json: unknown) =>
  Schema.decodeUnknown(WireRegistryIndexSchema)(json).pipe(
    Effect.mapError(
      (e) => new RegistryFetchError({ url, reason: `registry.json の形式ではありません: ${e.message.slice(0, 300)}` }),
    ),
  )

/**
 * registry.json を取得してデコードする。`include` (分割インデックス) は 1 階層だけ展開する。
 */
export const fetchRegistryIndex = (locator: RegistryLocator) =>
  Effect.gen(function* () {
    const http = yield* RegistryHttp
    const root = yield* decodeIndex(locator.indexUrl, yield* http.getJson(locator.indexUrl))
    if (!root.include || root.include.length === 0) return root
    const chunks = yield* Effect.forEach(
      root.include,
      (rel) => {
        const url = new URL(rel, locator.indexUrl).toString()
        return http.getJson(url).pipe(Effect.flatMap((json) => decodeIndex(url, json)))
      },
      { concurrency: 4 },
    )
    return { ...root, items: [...root.items, ...chunks.flatMap((c) => c.items)] } satisfies WireRegistryIndex
  })

/** shadcn 公式ディレクトリを取得。失敗しても登録フロー自体は止めない (名前空間推定はベストエフォート) */
export const fetchDirectory = Effect.gen(function* () {
  const http = yield* RegistryHttp
  const config = yield* ExplorerConfig
  const json = yield* http.getJson(config.directoryUrl)
  const dir = yield* Schema.decodeUnknown(WireDirectory)(json).pipe(
    Effect.mapError((e) => new RegistryFetchError({ url: config.directoryUrl, reason: e.message.slice(0, 300) })),
  )
  return normalizeDirectory(dir)
})

const normalizeTemplate = (t: string) => t.replace(/\.json$/, "")

const matchDirectory = (
  entries: ReadonlyArray<WireDirectoryEntry>,
  locator: RegistryLocator,
): Option.Option<WireDirectoryEntry> =>
  Arr.findFirst(entries, (e) => normalizeTemplate(e.url) === normalizeTemplate(locator.itemUrlTemplate))

/**
 * ユーザー入力 (URL / @namespace) を実在するレジストリに解決する。
 * 候補ロケータを順に試し、最初に registry.json として読めたものを採用する。
 */
export const resolveRegistry = (rawInput: string) =>
  Effect.gen(function* () {
    const input: RegistryInput = yield* classifyRegistryInput(rawInput)
    const directory = yield* fetchDirectory.pipe(
      Effect.orElseSucceed((): ReadonlyArray<WireDirectoryEntry> => []),
    )

    let candidates: ReadonlyArray<RegistryLocator>
    let namespace: string | null = null
    if (input._tag === "Namespace") {
      const entry = directory.find((e) => e.name.toLowerCase() === input.namespace)
      if (!entry) return yield* new NamespaceNotFound({ namespace: input.namespace })
      namespace = entry.name
      const classified = yield* classifyRegistryInput(entry.url)
      candidates = candidateLocators(classified)
    } else {
      candidates = candidateLocators(input)
    }

    const tried: Array<string> = []
    for (const locator of candidates) {
      tried.push(locator.indexUrl)
      const result = yield* Effect.either(fetchRegistryIndex(locator))
      if (result._tag === "Right") {
        const directoryEntry = matchDirectory(directory, locator)
        return {
          locator,
          index: result.right,
          namespace: namespace ?? Option.getOrNull(Option.map(directoryEntry, (e) => e.name)),
          directoryEntry,
        } satisfies ResolvedRegistry
      }
    }
    return yield* new RegistryNotFound({ input: rawInput, tried })
  })

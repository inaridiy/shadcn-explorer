import { Effect, Layer, Option } from "effect"
import { BlobError, BlobStore } from "@shadcn-explorer/core/ports"

export const R2BlobStore = (bucket: R2Bucket) =>
  Layer.succeed(BlobStore, {
    put: (key, body, contentType) =>
      Effect.tryPromise({
        try: () =>
          bucket.put(key, body, {
            httpMetadata: {
              contentType,
              // キーにハッシュを含むので不変として長期キャッシュできる
              cacheControl: key.startsWith("uploads/") ? "private, max-age=0" : "public, max-age=31536000, immutable",
            },
          }),
        catch: (e) => new BlobError({ key, reason: String(e) }),
      }).pipe(Effect.asVoid),
    get: (key) =>
      Effect.tryPromise({
        try: async () => {
          const obj = await bucket.get(key)
          return obj ? Option.some(new Uint8Array(await obj.arrayBuffer())) : Option.none()
        },
        catch: (e) => new BlobError({ key, reason: String(e) }),
      }),
    remove: (keys) =>
      Effect.tryPromise({
        try: () => bucket.delete([...keys]),
        catch: (e) => new BlobError({ key: keys.join(","), reason: String(e) }),
      }),
  })

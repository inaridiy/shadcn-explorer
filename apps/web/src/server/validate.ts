import { ParseResult, Schema } from "effect"

/** Effect Schema を createServerFn の validator に渡すためのアダプタ */
export const validateWith =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (input: unknown): A => {
    const result = Schema.decodeUnknownEither(schema)(input)
    if (result._tag === "Left") throw new Error(ParseResult.TreeFormatter.formatErrorSync(result.left))
    return result.right
  }

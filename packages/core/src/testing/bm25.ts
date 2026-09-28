/**
 * 最小の BM25 実装 (Okapi BM25, k1=1.2, b=0.75)。
 * 本番のキーワード検索は Cloudflare AI Search の BM25 を使うが、
 * ローカル開発とテストでも同じ性質のランキングを得るために用意している。
 */

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/

/** 英数字は単語単位、日本語 (CJK) は文字 bi-gram に分割する */
export const tokenize = (text: string): Array<string> => {
  const tokens: Array<string> = []
  for (const chunk of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (chunk.length === 0) continue
    if (CJK.test(chunk)) {
      const chars = [...chunk]
      if (chars.length === 1) tokens.push(chunk)
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i]! + chars[i + 1]!)
    } else {
      tokens.push(chunk)
    }
  }
  return tokens
}

interface DocStats {
  readonly tf: Map<string, number>
  readonly length: number
}

export class Bm25Index {
  private readonly docs = new Map<string, DocStats>()
  private readonly df = new Map<string, number>()
  private totalLength = 0

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  upsert(id: string, text: string): void {
    this.remove(id)
    const tokens = tokenize(text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    this.docs.set(id, { tf, length: tokens.length })
    this.totalLength += tokens.length
  }

  remove(id: string): void {
    const prev = this.docs.get(id)
    if (!prev) return
    for (const t of prev.tf.keys()) {
      const n = (this.df.get(t) ?? 1) - 1
      if (n <= 0) this.df.delete(t)
      else this.df.set(t, n)
    }
    this.totalLength -= prev.length
    this.docs.delete(id)
  }

  search(query: string): Array<{ readonly id: string; readonly score: number }> {
    const n = this.docs.size
    if (n === 0) return []
    const avgdl = this.totalLength / n
    const terms = [...new Set(tokenize(query))]
    const results: Array<{ id: string; score: number }> = []
    for (const [id, doc] of this.docs) {
      let score = 0
      for (const term of terms) {
        const f = doc.tf.get(term)
        if (!f) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * doc.length) / avgdl))
      }
      if (score > 0) results.push({ id, score })
    }
    return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  }
}

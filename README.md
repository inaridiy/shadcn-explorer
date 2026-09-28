# Shadcn Explorer

shadcn レジストリを登録すると、全コンポーネントを自動で取り込み、使い方ドキュメントとプレビューを生成して、**全レジストリ横断で検索**できるようにするアプリ。Coding Agent からは MCP で使える。

- キーワード (BM25) / 意味 / 見た目 (マルチモーダル) / ハイブリッド検索、画像での検索
- ui.shadcn.com/docs/components/* と同じ構成のドキュメント (`gpt-6-luna` がソースを読んで生成)
- プレビューはサンドボックスの Coding Agent がデモを作り、Browser Rendering で撮影する
- MCP (`search_components` / `get_component` / `list_registries`) と REST API

設計の詳細・コスト試算・未決事項は [docs/DESIGN.md](docs/DESIGN.md) を参照。

## 構成

```
packages/core   ドメイン (Effect Schema の ADT、純粋関数) / ポート (Context.Tag) / ユースケース / インメモリ実装
apps/web        Cloudflare Worker: TanStack Start (UI + createServerFn)、Hono (REST / MCP / 認証)、
                アダプタ (D1, R2, Vectorize, Browser Rendering, Gemini, OpenAI, CF-Open-Agents-API)、Workflows
```

## ローカル開発 (API キー無しで動く)

```bash
pnpm install
cd apps/web
cp .dev.vars.example .dev.vars        # EXPLORER_MODE=local
pnpm db:migrate:local
pnpm dev                              # http://localhost:3000
```

- `EXPLORER_MODE=local` では D1 / R2 は Miniflare、検索は D1 FTS5 と D1 上のベクトル、AI はフェイクで動く。
- `.dev.vars` に `OPENAI_API_KEY` を入れると、ドキュメント生成だけ本物の `gpt-6-luna` になる。

## テスト・評価

```bash
pnpm -r test                          # core の単体テスト (インメモリ Layer)
pnpm -r typecheck
pnpm --filter @shadcn-explorer/core eval:search -- --base http://localhost:3000 --cookie "<session cookie>"
```

## デプロイ

手順の抜粋は [docs/DESIGN.md §12](docs/DESIGN.md) にある。D1 / R2 / Vectorize (メタデータインデックス `registry_id` `kind` `modality`) を作り、シークレット (`BETTER_AUTH_SECRET` `OPENAI_API_KEY` `GEMINI_API_KEY` ほか) を設定してから `pnpm deploy` する。プレビュー生成を有効にするには、別途 [CF-Open-Agents-API](https://github.com/inaridiy/CF-Open-Agents-API) をデプロイして Service Binding `AGENTS` で繋ぐ。

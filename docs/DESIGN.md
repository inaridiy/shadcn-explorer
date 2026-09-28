# Shadcn Explorer 設計ドキュメント (v0.1 / 2026-09-28 時点)

> shadcn レジストリの URL を登録すると、全コンポーネントを自動で列挙し、Coding Agent が使い方ドキュメントとプレビューを生成し、
> Playwright でスクショを撮り、**全レジストリ横断で BM25・意味・マルチモーダル検索**できるようにする。

## 1. 課題とコア体験

- shadcn エコシステムは公式ディレクトリだけで 382 レジストリ (2026-09 時点) あり、「かっこいいボタンが欲しい」ときにレジストリを横断して探す手段がない。
- コア体験は次の 3 つ。
  1. **探す**: 自然文 (「かっこいいボタン」)・キーワード・**画像 (スクショ/デザインカンプを貼る)** で横断検索する。結果はスクショのグリッドで表示する。
  2. **理解する**: ui.shadcn.com/docs/components/* と同じ粒度のページ (Preview / Installation / Usage / Examples / API Reference) を、レジストリ側にドキュメントが無くても Coding Agent が生成する。
  3. **使う**: インストールコマンド、Agent 向けプロンプト、**MCP** を提供し、Claude Code / Codex / Cursor が自分で検索して正しく使えるようにする。

## 2. 全体アーキテクチャ

すべて Cloudflare 上で完結させる (単一 Worker + マネージドサービス)。

```
                ┌──────────────────────────── Cloudflare Worker (apps/web) ────────────────────────────┐
 Browser ──SSR──▶ TanStack Start (routes) ──▶ createServerFn (presentation) ─┐                          │
 Agent  ──MCP──▶ Hono  /mcp  /api/v1/*  /api/auth/*  /media/* ───────────────┤                          │
                │                                                            ▼                          │
                │                 ManagedRuntime  ◀── Layer (Composition Root: env → adapters)          │
                │                        │                                                               │
                │     @shadcn-explorer/core   application (use cases, Effect)                            │
                │                        │  ports (Context.Tag)       domain (Schema ADT, pure fns)      │
                │   Workflows: SyncRegistryWorkflow / EnrichBatchWorkflow      cron: 日次再同期         │
                └────────┬─────────┬──────────┬───────────┬──────────┬───────────┬─────────────┬───────┘
                         D1        R2     AI Search    Vectorize   Browser     Gemini API    CF-Open-Agents-API
                   (集約・台帳・  (スクショ・ (BM25+vector  (1536d      Rendering   (embedding-2,  (Service Binding,
                    FTS5・Auth)  preview)   テキスト)    multimodal)  (Playwright) AI Gateway)   Codex 等のサンドボックス)
```

| 関心事 | 採用技術 |
| --- | --- |
| フロントエンド | TanStack Start 1.168 (React 19, file routes), Tailwind v4, shadcn 流の UI |
| フロント向けバックエンド | `createServerFn` をプレゼンテーション層として使う (`apps/web/src/server/*`) |
| アプリ外向けバックエンド | Hono: REST `/api/v1/*`、MCP `/mcp`、Better Auth `/api/auth/*`、R2 配信 `/media/*` |
| ドメイン/アプリケーション | Effect 3.22 (Schema による ADT、Context.Tag のポート、Layer による DI) |
| 認証 | Better Auth 1.7 (D1 ネイティブ)。GitHub OAuth・メール、`@better-auth/api-key` で外部 API キー |
| 非同期処理 | Cloudflare Workflows (永続ステップ) + Cron Trigger |
| Coding Agent | CF-Open-Agents-API (OpenAI Agents API 互換) を Service Binding で呼ぶ |
| 検索 | AI Search (BM25 + ベクトルのハイブリッド)、Vectorize と gemini-embedding-2 (マルチモーダル)、D1 FTS5 (代替 BM25) |
| スクショ | Browser Rendering + `@cloudflare/playwright` |

## 3. レイヤ構成 (関数型 DDD / ヘキサゴナル)

```
packages/core/src
├── domain/        純粋。Effect Schema の ADT とドメイン関数 (I/O なし)
├── ports/         Context.Tag で定義した境界 (Repository, CodingAgent, Embedder, ...)
├── application/   ユースケース。Effect.gen でポートを合成する
└── testing/       ポートのインメモリ実装 (BM25・ハッシュ埋め込み・フェイク Agent)
apps/web/src
├── infrastructure/  アダプタ (D1, R2, AI Search, Vectorize, Gemini, Browser, Agents, Workflows)
│   └── layers.ts    Composition Root: env → Layer
├── server/          createServerFn + DTO (プレゼンテーション層)
├── api/             Hono (REST, MCP)
├── workflows/       Cloudflare Workflows (ユースケースをステップ単位で実行する)
└── routes/          TanStack Router の画面
```

- application は ports にしか依存しない。本番は `makeAppLayer(env)`、テストは `makeInMemoryLayer()` を差し込むので、全ユースケースを I/O 無しで単体テストできる (現在 48 テスト)。
- `EXPLORER_MODE=local` では D1/R2 (Miniflare)、D1 FTS5、フェイク AI の組み合わせになり、API キーも Cloudflare アカウントも無しでアプリ全体が動く。
- エラーは 2 種類に分ける。ドメイン/インフラの失敗は `Data.TaggedError` で型に出し、`describeError` がプレゼンテーション層で HTTP ステータスとメッセージに変換する。欠陥 (Die) はログに残して 500 を返す。

## 4. ドメインモデル (代数的データ型)

### 4.1 集約と値

| 型 | 種類 | 説明 |
| --- | --- | --- |
| `RegistryInput` | 直和型 | `IndexUrl` / `ItemTemplate` / `Namespace` / `ItemUrl` / `SiteUrl` のいずれか。ユーザー入力を分類した結果 |
| `RegistryLocator` | 値 | `indexUrl` と `itemUrlTemplate` の組 (`{name}` を含む) |
| `Registry` | 集約 | id (slug)、namespace、locator、owner、`RegistryStatus` |
| `RegistryStatus` | 直和型 | `Pending` / `Syncing` / `Active` / `Failed` / `Disabled` |
| `ComponentSnapshot` | エンティティ | レジストリから取得した事実。`contentHash` を持つ |
| `ComponentKind` | リテラル和 | `ui` / `block` / `hook` / `theme` / ... / `unknown` (未知の型も落とさない) |
| `UsageDoc` | 値 | Agent が生成する。summary、visualDescription、usage、examples、props、agentPrompt、keywords |
| `EnrichmentState` | 積型 | `DocState` × `PreviewState` × `IndexState`。それぞれが直和型で、どのソースハッシュから作ったかを保持する |
| `EnrichmentStep` | 直和型 | `GenerateDoc` / `CapturePreview` / `Index{withImage}` |
| `SearchQuery` | 直和型 | `Text{text, mode, filters}` / `Image{imageKey}` |
| `BudgetDecision` | 直和型 | `Proceed` / `Degrade{allowed, deferred}` / `Defer{reason}` |
| `MicroUsd` | ブランド型 | 金額を 1e-6 USD 単位の整数で持つ (浮動小数の誤差を避けるため) |

外部フォーマット (`registry.json` / `registry-item.json`) は `registry-wire.ts` の腐敗防止層でだけ扱い、ドメインへは `toComponentSnapshot` を通して変換する。

### 4.2 状態遷移 (Registry)

```
Pending ─startSync─▶ Syncing ─completeSync─▶ Active ─startSync─▶ Syncing ...
                        └────failSync────▶ Failed ─startSync─▶ Syncing
Syncing がタイムアウト (isStaleSync) したら、Failed に落としてから再開する
```

遷移は `Either<Registry, IllegalRegistryTransition>` を返す純粋関数として書いている。

### 4.3 主要な純粋関数

- `classifyRegistryInput` / `candidateLocators`: 入力から試すべき registry.json の候補を導出する。https 以外、IP リテラル、localhost、認証情報付き URL は拒否する (SSRF 対策)。
- `planSync(existing, fetched)`: `contentHash` を比べて、新規 / 変更 / 不変 / 削除に分類する。
- `planEnrichment(snapshot, state, policy)`: 必要なステップだけを返す。ハッシュが一致すれば空配列 (コスト 0)。hook/lib はスクショを撮らない。失敗が `maxAttempts` 回に達したら、ソースが変わるまで再試行しない。
- `decideBudget(steps, spent, budget, prices)`: 実行する / 高価なステップを後回しにする / 実行しない、を決める。
- `reciprocalRankFusion(lists)`: 検索ランキングを融合する (§7)。

## 5. レジストリ登録フロー

```
[1] 入力      "@magicui" | "https://acme.dev" | ".../r/registry.json" | ".../r/{name}.json"
[2] 解決      classify → 候補ロケータ列挙 → registry.json を順に取得・Schema でデコード
              (@namespace は公式ディレクトリ registries.json で解決する。URL 入力でもディレクトリと照合して namespace を推定する)
[3] 確認画面  名前、アイテム数、kind 別件数、サンプル、ディレクトリのヘルス、初回処理の見積もりコスト、既登録かどうか、上限超過かどうか
[4] 登録      重複 (indexUrl) と巨大レジストリ (既定 500 件超) を拒否 → Registry(Pending) を保存 → SyncRegistryWorkflow を投入
[5] 同期      index を取得 → 各 item を並列度 6 で取得 (インデックスに内容が同梱されていれば省略) → planSync → 差分だけ保存 → 削除分は検索インデックスからも消す
[6] エンリッチ 新規・変更分を ENRICH_PARALLELISM 本のバッチ Workflow に分けて処理する
[7] 日次 cron  全レジストリを再同期する。差分が無ければ AI コストは発生しない
```

- 登録にはログインが必要。再同期できるのは登録者だけ (`requestResync`)。
- 取得は 5MB 上限、15 秒タイムアウト、5xx の場合だけ指数バックオフで再試行する。

## 6. AI 連携

### 6.1 Coding Agent によるドキュメント・プレビュー生成

- 実行環境は **CF-Open-Agents-API** (OpenAI Agents API `agents=v1` 互換)。Service Binding の `fetchAs(tenant, req)` で呼ぶので、Worker 間でトークンを受け渡さない。
- **モデル指定について (要確認)**: クライアントはモデル名ではなく**プリセット名** (`AGENT_PRESET`、既定 `codex`) を送る。実モデルへの割り当ては Agents API 側の `defineAgentWorker` で設定する。リポジトリ内に `gpt-6-luan` は見当たらず、近いのは `gpt-6-astra` (openai) と `gpt-5.6-luna` (openaiFast) だった。
- 1 コンポーネントにつき 1 セッションで、サンドボックス内で次を行う。
  1. Vite + React + Tailwind v4 の雛形を作り、`shadcn init` と `shadcn add <item>` を実行する
  2. ソースを読んで実際の API を把握し、デモ `App.tsx` を書く (`#preview` ラッパー、`.dark` 対応)
  3. `vite-plugin-singlefile` で自己完結 HTML にビルドして `/workspace/outputs/preview.html` に置く
  4. `/workspace/outputs/doc.json` (`UsageDoc`) を書く。コード例は `tsc` で検証させる
- Worker 側はセッション状態を 10 秒間隔でポーリングし (15 分でタイムアウト)、終わったら Artifact を回収して Schema で検証し、セッションを削除する。Idempotency-Key には `componentId + contentHash` を使う。
- 失敗はドメイン状態 `DocState.Failed{attempts}` に記録する。無限リトライで課金が続くのを防ぐため、Workflow のリトライとは分けて管理している。

### 6.2 プレビュー撮影

- Browser Rendering (Playwright) を使う。**1 回の起動で light と dark の両方を撮る** (起動時間が課金の大半を占めるため)。外部リクエストはすべて遮断し、`#preview` 要素だけを撮る。
- 生成した HTML はサイト上でも **Live プレビュー** として iframe で表示する。信頼できない HTML なので `sandbox="allow-scripts"` (allow-same-origin なし) にし、配信時にも `CSP: sandbox` を付けて不透明オリジンで動かす。

### 6.3 Agent から使う (MCP / REST)

- `/mcp` は Streamable HTTP の stateless / JSON モードで、ツールは `search_components` / `get_component` / `list_registries`。SDK を使わず JSON-RPC を直接処理しているので、Workers でもセッション状態を持たない。
  `claude mcp add --transport http shadcn-explorer https://<host>/mcp --header "x-api-key: sce_..."`
- REST: `GET /api/v1/search?q=&mode=&kind=&registry=`、`POST /api/v1/search/image`、`GET /api/v1/components/:registry/:name`、`GET|POST /api/v1/registries`
- コンポーネントページには「Copy docs as Markdown」と「Copy agent prompt」ボタンを置く。

## 7. 検索設計

| モード | バックエンド | 得意なこと |
| --- | --- | --- |
| keyword | AI Search `retrieval_type: keyword` (BM25, trigram)、または D1 FTS5 `bm25()` | 固有名詞、パッケージ名、型名 |
| semantic | AI Search `retrieval_type: vector` (`gemini-embedding-001`) | 言い換え、用途からの検索 |
| visual | Vectorize と **gemini-embedding-2** (1536d) | テキストからスクショ ("かっこいい" のような見た目の形容)、画像から画像 |
| hybrid (既定) | 上 3 つを RRF で融合 | 総合 |

- **AI Search では gemini-embedding-2 を選べない** (2026-09 時点で使える Google モデルは text-only の `gemini-embedding-001` だけで、画像はキャプションに変換されてから埋め込まれる)。そのため、テキストのハイブリッド検索は AI Search、真のマルチモーダル検索は Vectorize と Gemini Embedding 2、という二段構成にした。
- Vectorize には 1 コンポーネントあたり最大 3 ベクトル (`doc` = UsageDoc のテキスト、`light` / `dark` = スクショ) を入れる。gemini-embedding-2 はテキストと画像を同じ空間に埋め込むので、テキストクエリでスクショを直接引ける。
- 埋め込みの指示はプレフィックスで行う (task type パラメータは廃止された)。クエリは `task: search result | query: …`、文書は `title: … | text: …`。
- **融合 (RRF)**: 各バックエンドのスコアはスケールが違うので、順位だけで融合する。

$$
\mathrm{score}(d) \;=\; \sum_{i \in \text{sources}} \frac{w_i}{k + \mathrm{rank}_i(d)}, \qquad k = 60
$$

  重みは $w_{\text{keyword}} = 1.2$、$w_{\text{semantic}} = 1.0$、$w_{\text{visual-text}} = 0.9$、$w_{\text{visual-image}} = 1.0$。
- バックエンドの一部が失敗しても残りで結果を返し、失敗は `warnings` として返す (劣化運転)。
- 日本語対策として、AI Search は `keyword_tokenizer: "trigram"`、D1 FTS5 は `tokenize='trigram'`、インメモリ BM25 は CJK 文字 bi-gram を使う。

## 8. 認証・認可

- Web UI: Better Auth のセッション Cookie (GitHub OAuth とメール/パスワード)。server fn では `*.server.ts` に置いた `requireUserId()` で確認する。
- 外部: `x-api-key` (プレフィックスは `sce_`)。キーごとに 60 req/分のレート制限をかけ、超えたら 429 を返す。埋め込み呼び出しのコストを抑える狙いもある。
- 閲覧系の画面は公開、登録と再同期はログイン必須、REST と MCP は API キー必須。

## 9. コスト設計

### 9.1 単価の前提 (2026-09 時点)

| 項目 | 単価 |
| --- | --- |
| Coding Agent 1 回 | 見込み **$0.12** (約 60k 入力 + 8k 出力トークン + サンドボックス数分。**プリセットのモデル単価次第なので要実測**) |
| Browser Rendering | \$0.09 / browser-hour (月 10 時間は無料) → 1 プレビュー約 8 秒 ≈ $0.0002 |
| gemini-embedding-2 | テキスト \$0.20 / 1M tokens、画像 約 \$0.00012 / 枚 (Batch API なら半額) |
| AI Search | オープンベータ中は無料 (Workers AI / AI Gateway の利用分は別途) |
| Vectorize | 保存 10M 次元まで無料、以降 \$0.05 / 100M 次元。クエリ 50M 次元まで無料、以降 \$0.01 / 1M 次元 |
| Workflows / Queues | 月 50 万ステップまで無料 (課金はまだ始まっていない) |

### 9.2 1 コンポーネントあたりの初回コスト

$$
C_{\text{item}} = C_{\text{agent}} + t_{\text{browser}} \cdot p_{\text{browser}} + C_{\text{text-emb}} + n_{\text{img}} \cdot C_{\text{img-emb}}
\approx 0.12 + 0.0002 + 0.0004 + 2 \times 0.00012 \approx \$0.121
$$

**Agent が 99% 以上を占める。** 規模ごとの目安は次のとおり。

- 500 件のレジストリ 1 つ: $\approx 500 \times 0.121 \approx \$60$
- 公式ディレクトリ全体 (382 レジストリ、平均 50 件と仮定して約 19k 件): $\approx \$2{,}300$ (初回のみ)

### 9.3 継続コスト

- 再同期は `contentHash` が同じなら **\$0** (差分計算に必要なのは HTTP 取得だけ)。変更率を $r$ とすると、月次コストは $\approx r \cdot N \cdot C_{\text{item}}$。
- 検索 1 回あたりは Gemini のクエリ埋め込み (約 20 tokens ≈ \$0.000004) と Vectorize。Vectorize のクエリ次元は $(V_{\text{stored}} + Q) \times d$ で課金される。例: $V = 57{,}000$ ベクトル (19k × 3)、$Q = 100{,}000$ クエリ/月、$d = 1536$ なら約 241M 次元なので、無料枠を超えた分で \$2 程度/月。

### 9.4 コスト制御の仕組み

1. **ハッシュによるスキップ**: `planEnrichment` はソースが変わったときだけ実行する。
2. **予算ガード**: `decideBudget` が月次予算 (`MONTHLY_BUDGET_USD`) を見て判断する。ソフトリミット 80% を超えたら Agent と Browser を後回しにしてインデックスだけ更新し (`Degrade`)、100% を超えたら何もしない (`Defer`)。
3. **実コストの台帳**: `usage_records` にカテゴリ別に記録し、/settings で当月の消費を表示する。
4. **失敗の上限**: 同じソースで 3 回失敗したら、ソースが変わるまで諦める。
5. **登録時の見積もり提示**と、**1 レジストリあたりの件数上限** (500)。
6. **並列度の制限** (`ENRICH_PARALLELISM`): Agent と Browser の同時実行数を抑え、瞬間的なコストを平準化する。
7. 非ビジュアルな kind (hook/lib/file) はスクショを撮らない。

今後の改善案:
- 埋め込みを Gemini Batch API に寄せて半額にする。
- Agent を 2 段階にする。安いモデルで doc.json、高いモデルはプレビュー生成だけに使う。
- 人気のないレジストリは遅延エンリッチにする (検索でヒットしてから生成する)。
- AI Gateway のキャッシュを使う。

## 10. セキュリティ

- **SSRF**: https のみ許可し、IP リテラル、`localhost`、`.internal`、認証情報付き URL は拒否する。サイズ上限とタイムアウトも設けている (Workers から内部ネットワークには届かないが、多層防御として入れている)。
- **生成 HTML**: 不透明オリジンのサンドボックスで実行し、CSP で外部通信を禁止する。撮影時もネットワークを遮断している。
- **FTS インジェクション**: クエリの各トークンをフレーズ化して、演算子を無効化する。
- **ログイン後のリダイレクト**: 同一オリジンのパスだけを許可する。
- **アップロード**: PNG/JPEG をマジックナンバーで判定し、4MB 上限。`uploads/` は非公開で、R2 のライフサイクルルールにより 1 日で削除する。

## 11. 現状と TODO

**実装済み**
- core: ドメイン、ユースケース、インメモリアダプタ、テスト 48 件 (すべて成功)
- web: 全アダプタ、Workflows、server fn、Hono (REST/MCP)、Better Auth、画面 (検索、詳細、レジストリ、登録フロー、ログイン、API & MCP 設定)。`tsc` と `vite build` が通る

**ローカルでの E2E 確認 (`EXPLORER_MODE=local`、実在レジストリ使用)**
- サインアップ → API キー発行 → `@23rd` (28 件) と `https://www.8bitcn.com` (121 件、`/r/registry.json` を自動発見し、`@8bitcn` をディレクトリから推定) の登録 → 同期 → Active まで確認済み
- API キーのレート制限が発動することも確認済み。これを受けて 429 を返すように修正した
- エンリッチは途中まで確認: ローカルで未起動の Agents Service Binding を掴んでいたバグを修正した後、dev サーバーのリロードでインラインキューが途切れて止まっている。**検索と MCP の E2E 確認はまだ**

**要確認・未決事項**
1. Agent のプリセットとモデル名 (`gpt-6-luan` → `gpt-6-astra` か `gpt-5.6-luna` か) と、その単価 (コスト試算の最大要因)
2. AI Search の Items API で、同じキーを再アップロードしたときに上書き扱いになるかの実機確認
3. Agent のポーリングは今 1 つの Workflow ステップ内で待っている → `step.sleep` を使った 2 段階化 (開始 → 待機 → 回収) で実行時間を抑える
4. 公式ディレクトリを一括インポートするか (初回約 \$2.3k の見積もり)。するなら、人気順に段階的に取り込む案
5. デプロイ手順書 (D1/R2/Vectorize/AI Search インスタンスの作成、メタデータインデックス、シークレット)

## 12. セットアップ (抜粋)

```bash
pnpm install
cd apps/web && cp .dev.vars.example .dev.vars   # EXPLORER_MODE=local
pnpm db:migrate:local && pnpm dev               # http://localhost:3000
pnpm -r test                                     # core の単体テスト

# 本番リソース
wrangler d1 create shadcn-explorer
wrangler r2 bucket create shadcn-explorer-media
wrangler vectorize create shadcn-explorer-visual --dimensions=1536 --metric=cosine
wrangler vectorize create-metadata-index shadcn-explorer-visual --property-name=registry_id --type=string
wrangler vectorize create-metadata-index shadcn-explorer-visual --property-name=kind --type=string
# AI Search インスタンス "shadcn-explorer": 組み込みストレージ、index_method {vector, keyword}、trigram、
#   embedding_model google-ai-studio/gemini-embedding-001、custom_metadata: component_id, registry_id, kind
wrangler secret put BETTER_AUTH_SECRET GEMINI_API_KEY GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
pnpm db:migrate:remote && pnpm deploy
```

# Shadcn Explorer 設計ドキュメント (v0.7 / 2026-10-01 時点)

> shadcn レジストリの URL を登録すると、全コンポーネントを自動で列挙し、LLM が使い方ドキュメントとデモを書き、デモをコンテナで決定的にビルドし、
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
                │   Workflows: SyncRegistryWorkflow / EnrichBatchWorkflow   cron: 再同期 + backlog sweeper │
                └──────┬─────────┬───────────┬──────────┬───────────┬──────────────┬──────────────────┬──┘
                       D1        R2       Vectorize   Gemini API     OpenAI API      Sandbox (Containers)   CF-Open-Agents-API
                 (集約・台帳・ (item原本・  (1536d:    (embedding-2)  (gpt-6-luna:     (preview-harness:      (フォールバックの
                  FTS5 BM25・  デモ・HTML・ doc/light/                ドキュメント・   shadcn add → build →   Coding Agent:
                  Auth)        スクショ)   dark)                     デモ)            Playwright で撮影)     ビルド手順を書く)
                  Auth)        preview)    dark)                   ※ AI Search は BM25 の代替実装として任意
```

| 関心事 | 採用技術 |
| --- | --- |
| フロントエンド | TanStack Start 1.168 (React 19, file routes), Tailwind v4, shadcn 流の UI |
| フロント向けバックエンド | `createServerFn` をプレゼンテーション層として使う (`apps/web/src/server/*`) |
| アプリ外向けバックエンド | Hono: REST `/api/v1/*`、MCP `/mcp`、Better Auth `/api/auth/*`、R2 配信 `/media/*` |
| ドメイン/アプリケーション | Effect 3.22 (Schema による ADT、Context.Tag のポート、Layer による DI) |
| 認証 | Better Auth 1.7 (D1 ネイティブ)。GitHub OAuth・メール、`@better-auth/api-key` で外部 API キー |
| 非同期処理 | Cloudflare Workflows (永続ステップ) + Cron Trigger |
| ドキュメント生成 | OpenAI Responses API を直接呼ぶ (`gpt-6-luna`, Structured Outputs で 1 回呼び出し) |
| プレビュー生成 | デモ (`demo.tsx`) は OpenAI Responses API 1 回、ビルドは Cloudflare Sandbox (Containers) のハーネスで決定的に行う (§6.2) |
| 検索 | BM25 は D1 FTS5 (既定。AI Search も選べる)、意味検索とビジュアル検索は Vectorize と gemini-embedding-2 |
| スクショ | ビルド用コンテナ内の Playwright + Chromium (v0.5。録画から動くサムネイルも作る) |

## 3. レイヤ構成 (関数型 DDD / ヘキサゴナル)

```
packages/core/src
├── domain/        純粋。Effect Schema の ADT とドメイン関数 (I/O なし)
├── ports/         Context.Tag で定義した境界 (Repository, DocWriter, DemoWriter, PreviewCompiler, Embedder, VectorIndex, ...)
├── application/   ユースケース。Effect.gen でポートを合成する
└── testing/       ポートのインメモリ実装 (BM25・ハッシュ埋め込み・フェイク LLM / コンパイラ)
apps/web/src
├── infrastructure/  アダプタ (D1, R2, D1 FTS5 / AI Search, Vectorize, Gemini, OpenAI, Browser, Sandbox, Workflows)
│   └── layers.ts    Composition Root: env → Layer
├── server/          createServerFn + DTO (プレゼンテーション層)
├── api/             Hono (REST, MCP)
├── workflows/       Cloudflare Workflows (ユースケースをステップ単位で実行する)
└── routes/          TanStack Router の画面
```

- application は ports にしか依存しない。本番は `makeAppLayer(env)`、テストは `makeInMemoryLayer()` を差し込むので、全ユースケースを I/O 無しで単体テストできる (現在 63 テスト)。
- `EXPLORER_MODE=local` では D1/R2 (Miniflare)、D1 FTS5、D1 上のベクトル (総当たり)、フェイク AI の組み合わせになり、API キーも Cloudflare アカウントも無しでアプリ全体が動く。`OPENAI_API_KEY` があればドキュメント生成だけ本物の `gpt-6-luna` になる。
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
| `UsageDoc` | 値 | LLM が生成する。summary、visualDescription、usage、examples、props、accessibility、keywords (日本語の同義語を含む)。**Agent 向けプロンプトは含めない** (§10) |
| `EnrichmentState` | 積型 | `DocState` × `PreviewState` × `IndexState`。それぞれが直和型で、どのソースハッシュから作ったかと、失敗なら試行回数を保持する |
| `PreviewState` | 直和型 | `NotCaptured` → `Built` (HTML・デモあり) → `Captured` (スクショあり、`captureVersion`、動く部品は `motion`、埋め込み用 JPEG は `embedImages`)、`Skipped{sourceHash}`、`Failed{stage, cause, escalated, attempts}`。`sourceHash` は `previewSourceHash(contentHash, BUILD_VERSION)`。Built / Captured はビルドの由来 (`buildKind: core / agent`、`workarounds`、`manifestKey`) を持つ |
| `PreviewFailureCause` | リテラル和 | `registry` (公開されたままでは入らない・ビルドできない) / `demo` (デモが悪い) / `harness` (こちらのバグ) / `infra` (一時障害)。再試行・エージェントへの委譲・UI の出し分けが全部これで決まる (§6.3) |
| `BuildManifest` | 値 | フォールバックの Coding Agent が返すビルド手順。許可リストの操作 (`pin` / `add` / `addItem` / `writeFile` (src/compat 配下) / `alias` / `wrap`) と理由。`validateManifest` とハーネスの両方で検査する |
| `RegistryPreviewConfig` | 値 | レジストリ単位のプレビュー設定 (運営者が編集・テーマの提案を承認して入る)。ビルド時: `baseItems` / `themeVars` / `fonts` / `css` / 手書きの `themeCss` / `pins`。実行時: `tokens` / `variants` (CSS 変数の値)。レジストリ固有の事情をコードの分岐ではなくデータで吸収する (§6.6) |
| `RegistryTheme` | 直和型 | テーマの判定状態: `Unresolved` / `AgentPending` (プレビューを保留) / `Proposed{proposal}` (承認待ち) / `Resolved{source}` / `Failed`。`inputHash` (registry.json のテーマ系アイテムのハッシュ) が変われば判定し直す |
| `PreviewDemo` / `DemoLayout` | 値 | LLM が書く `src/demo.tsx` と枠 (`centered` / `fullwidth`)。枠は kind から決まり、モデルには選ばせない |
| `EnrichmentStep` | 直和型 | `GenerateDoc` / `BuildPreview` / `CapturePreview` / `Index{withImage}` |
| `UsageRecord` | 値 | 実コストの記録。カテゴリ (llm / sandbox / browser / embedding。agent は v0.2 の名残)、金額、帰属レジストリ、実トークン数 |
| `SearchQuery` | 直和型 | `Text{text, mode, filters}` / `Image{imageKey}` |
| `BudgetDecision` | 直和型 | `Proceed` / `Degrade{allowed, deferred}` / `Defer{reason}` |
| `MicroUsd` | ブランド型 | 金額を 1e-6 USD 単位の整数で持つ (浮動小数の誤差を避けるため) |
| `RegistryListing` | 直和型 | 出自: `Official{directoryName, listed}` / `Shadcn` / `Community{requestedVia, reference}` (v0.7、§5.1) |
| `DirectoryEntry` | 値 | 公式ディレクトリの 1 件と取り込みの状態 (`New` / `Imported` / `Skipped` / `Delisted`) |
| `LlmRouting` / `ModelChoice` | 値 / 直和型 | ステップごとのモデルの優先順と無料枠。`Use{model, free}` か `Wait` (§6.7) |
| `PipelineEvent` | 値 | 生成過程の公開ログの 1 行 (stage・status・公開してよい detail だけ。§6.8) |

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
- `planEnrichment(snapshot, state, policy)`: 必要なステップだけを返す。ハッシュが一致すれば空配列 (コスト 0)。hook/lib はプレビューを作らない。撮影だけ失敗した場合は HTML を作り直さない。失敗が `maxAttempts` 回に達したら、ソースが変わるまで再試行しない (doc / preview / index それぞれ独立に)。
- `decideBudget(steps, spent, budget, prices)`: 実行する / プレビュー (高価) だけ後回しにする / 実行しない、を決める。
- `llmCost(usage, rates)`: 実トークン数 × 単価 (キャッシュ分は安い単価) を計算する。
- `planEnrichment` はプレビューの鮮度を 2 つの版で判定する: `BUILD_VERSION` (ハーネス・プロンプト。上げると作り直し) と `CAPTURE_VERSION` (撮影方法。上げると既存の HTML を撮り直すだけ)。失敗の再試行は原因で決める (registry / harness は同じソース・版では再試行しない、demo はエージェントを試していなければ上限まで、infra は上限まで)。
- `lintDemo(code, itemImports)` / `itemImportPaths(itemJson)`: デモの決定的な検査 (見出し・偽のアプリ枠・テーマ切り替え・乱数・外部 URL の禁止、アイテム自身を import しているか)。コンテナを使う前に弾き、修正ターンに回す。
- `agentPromptFor` / `scanUntrustedText`: Agent 向けプロンプトの決定的な組み立てと、危険な兆候の検出 (§10)。
- `summarizeEvaluation`: 検索のゴールデンセットに対する recall@k と MRR (§7.3)。
- `reciprocalRankFusion(lists)`: 検索ランキングを融合する (§7)。

## 5. レジストリ登録フロー

```
[1] 入力      "@magicui" | "https://acme.dev" | ".../r/registry.json" | ".../r/{name}.json"
[2] 解決      classify → 候補ロケータ列挙 → registry.json を順に取得・Schema でデコード
              (@namespace は公式ディレクトリ registries.json で解決する。URL 入力でもディレクトリと照合して namespace を推定する)
[3] 確認画面  名前、アイテム数、kind 別件数、サンプル、ディレクトリのヘルス、初回処理の見積もりコスト、既登録かどうか、上限超過かどうか
[4] 登録      公式ディレクトリのものは日次の cron が自動で (§5.1)、それ以外は申請を運営者が (/admin)。重複 (indexUrl)、巨大レジストリ (既定 500 件超) を拒否
              → Registry(Pending) を保存 → SyncRegistryWorkflow を投入
[5] 同期      index を取得 → 各 item を並列度 6 で取得 (インデックスに内容が同梱されていれば省略) → planSync
              → 差分だけ保存し、registry-item.json の原本を R2 (items/…) に置く → 削除分は検索インデックスからも消す
[5'] テーマ   registry.json のテーマ系アイテムで決まればエンリッチの前に適用、決まらなければエージェント (§6.6)
[6] エンリッチ 新規・変更分を 1 件ずつ Cloudflare Queues に投入する。消費者が計画 → lease → Workflow 起動 → 終了まで待つ
              (max_concurrency が全体の同時実行数。同じコンポーネントの重複投入は計画と lease で落ちる)
[7] 日次 cron  公式ディレクトリの同期と取り込み + 前回から 7 日経ったレジストリの再同期 (古い順に 1 晩 60 件まで。差分が無ければ AI コスト 0)
              + backlog sweeper (予算・無料枠で後回し、一時失敗、後からプレビュー有効化など「ソースは同じだが未完了」のものを拾い直す)
              + 公開ログの掃除 (30 日)
```

- **申請の取り込み・再同期・作り直し・プレビュー設定は運営者だけ** (`ADMIN_USER_IDS`、v0.6)。一般ユーザーからの追加は GitHub Issues (テンプレート `registry-request.yml`) かメール (`REGISTRY_REQUEST_EMAIL`) で受け付ける。有料の申請 (Stripe Checkout) は需要が見えてから。
  運営者が登録したレジストリは所有者なし (`ownerId = null`) になる。ユーザー別の月次上限 (`MAX_ITEMS_PER_USER_PER_MONTH`) は一般ユーザーに登録を開放したとき用に core に残している。
  認可は presentation (server fn の `requireAdmin`、Hono の `isAdmin`) で行い、core のユースケースは誰が呼んだかを見ない。
  メール+パスワード登録はメール確認をしないので、運営者はメールアドレスではなくユーザー ID で指定する。
- 同期でアイテムの取得に失敗しても、そのアイテムは削除扱いにしない (v0.6)。以前は「index から消えた」と区別せずに物理削除していたため、一時的な 404・タイムアウトの翌日に全額で作り直していた。
- インデックスは**全ユーザー共通** (横断検索が価値なので)。所有者は「登録を要求した人」で、コストの帰属先として使う。
- 取得は 5MB 上限、15 秒タイムアウト、5xx の場合だけ指数バックオフで再試行する。

### 5.1 取り込みのライフサイクル (v0.7)

| 出自 (`Registry.listing`) | 取り込み | 検索での扱い |
| --- | --- | --- |
| `Official` (公式ディレクトリに掲載) | 日次の cron が自動で (`syncDirectory` → `intakeDirectory`) | OFFICIAL のバッジ。ギャラリーの「Official only」に入る |
| `Shadcn` (ui.shadcn.com 自身) | 運営者が登録 (ディレクトリには載っていない) | SHADCN/UI のバッジ |
| `Community` (それ以外) | 申請 (GitHub Issues / メール) を運営者が取り込む | COMMUNITY のバッジ付きで普通に検索に出る |

- ディレクトリの写しは `directory_entries` に持つ (`New` → `Imported` / `Skipped`、掲載が外れたら `Delisted`)。登録の入り口に関わらず、ディレクトリと照合できれば `Official` にする。掲載が外れた公式レジストリは残して同期も続けるが、バッジは外す (`listed=false`)。
- 取り込みの順は ranking の高い順、同点ならアイテム数の少ない順。1 回 10 件まで、未完了のコンポーネント (キューの backlog と、インデックスまで終わっていない数の大きい方) が 1,000 件を超えている間は止める。非表示・500 件超は `Skipped` にして毎日は試さない。取得の一時的な失敗は 3 回まで。
- 公式ディレクトリの規模 (2026-10-01、Fable の計測): 408 件、500 件以下で取り込めるのは 332 件・約 2.7 万アイテム。プレビュー込みで約 \$170〜400、4 並列のコンテナで約 4 日 (LLM の無料枠で待つ場合はもっと長い。§6.7)。

## 6. AI 連携

### 6.1 生成の段階

ドキュメントは検索に必要なので全件に安く付ける。プレビューは「LLM がデモのコードを書く」と「そのコードを決定的にビルドする」に分けた (v0.3)。

| ステップ | ポート | 実装 | 実測・見込み |
| --- | --- | --- | --- |
| GenerateDoc | `DocWriter` | OpenAI Responses API を直接 (`gpt-6-luna`)。registry-item.json (ソース込み) を読ませ、Structured Outputs で `UsageDoc` を 1 回で返させる | **実測: 平均 5.5k in / 1.9k out tokens、約 14 秒、\$0.0015 / 件、20/20 成功** |
| BuildPreview: GenerateDemo | `DemoWriter` | Responses API 1 回で `src/demo.tsx` だけを書かせる (§6.2) | ローカル実測 27 件: 平均 約 7k tokens (大半は入力)、\$0.001 前後 / 件 |
| BuildPreview: Compile ⇄ Repair | `PreviewCompiler` + `DemoWriter.repair` | Sandbox コンテナのハーネスで `shadcn add` → `vite build`。lint・ビルド・型エラーを LLM に返して最大 2 回直させる | コンテナ 3〜10 秒 / 回。ローカル実測 27/27 成功 (初回 24、修正 1 回 2、修正 2 回 1) |
| CapturePreview | `PreviewRenderer` | ビルド用コンテナ内の Playwright (render.mjs) | 静止画だけなら約 4 秒、動く部品は録画込みで約 10 秒 |
| Index | `Embedder` + `TextSearchIndex` + `VectorIndex` | gemini-embedding-2、D1 FTS5、Vectorize | テキスト 1 + 画像 2 ≈ \$0.0006 |

- **モデル**: `gpt-6-luna` (単価は \$0.10 / 1M input、\$0.01 / 1M cached input、\$0.50 / 1M output)。ドキュメントとデモで同じ `OPENAI_API_KEY` を使う。
- **Workflow のステップ分割**: `generateDemo` → `compileDemo(attempt)` → (`repairDemo(attempt)` → `compileDemo(attempt+1)`)* をそれぞれ別の `step.do` にする。デモのソースは試行ごとに R2 (`demos/…/{hash}-{attempt}.tsx`) に置き、ステップ間では試行番号だけを受け渡す。コンテナの一時障害で LLM 呼び出しを払い直さない。修正の方針 (回数、install 失敗は直さない、ビルドできた版は型エラーが残っていても Built にしておく) は core のユースケースにあり、フェイクでテストしている。
- **item 原本は同期時に R2 に保存する**: 生成時にレジストリへ取りに行かない。ハーネスもこの原本をローカルファイルとして `shadcn add` するので、個別 JSON を配信しないレジストリでもビルドできる。
- **失敗の扱い**: 永続化エラー以外の失敗は全て、ドメイン状態 (`Failed{attempts}`、プレビューは失敗段階も記録) に書いて成功扱いで返す。1 件の失敗でバッチ全体が止まらず、Workflow の自動リトライで無限に課金されることもない。再試行は `planEnrichment` の試行回数と、日次の backlog sweeper が管理する。

### 6.2 プレビュー: デモ = コード、プレビュー = そのビルド (v0.3)

v0.2 ではサンドボックスの Coding Agent (CF-Open-Agents-API) に「洗練されたデモ」を作らせていた。結果は 2 つの理由で使えなかった。

- **見た目**: 成功した 30 件は、偽のブランドヘッダー・見出し・ダークモードボタン・バリアント一覧を持つ「ランディングページ」になった。枠 (`#preview`) の中身をモデルが全部決めていたため。
- **信頼性とコスト**: 121 件中 91 件が `environment_setup_failed`。成功も 1 件 7 分・\$0.033。

v0.3 では、ui.shadcn.com のドキュメント冒頭にあるデモ (accordion-demo、button-demo など) と同じものを目標にし、責務を分けた。

1. **DemoWriter (LLM)** は `src/demo.tsx` 1 ファイルだけを書く。プロンプトには shadcn 公式のデモ 4 本を良い例として、v0.2 のランディングページを悪い例として入れる。見出し・偽のアプリ枠・テーマ切り替え・乱数・外部 URL・画面高さ指定は禁止し、`lintDemo` でも機械的に弾く。オーバーレイ系 (dialog / sheet / popover / dropdown) は `defaultOpen` で開いた状態にさせる。
2. **ハーネス (信頼できるコード、`apps/web/preview-harness/`)** が枠を持つ。`main.tsx` が `#preview` (docs と同じ中央寄せ、ブロック・ページは全幅)、テーマ (`?theme=` と postMessage)、高さの通知、エラーバウンダリを担当する。イメージには Vite 8 + React 19 + Tailwind v4 + shadcn (neutral) + vite-plugin-singlefile と、よく使われる依存 (radix-ui 各種、@base-ui/react、motion、recharts など) と shadcn/ui の基本部品を焼き込んでいる。`next/link` `next/image` `next/font/*` などはスタブに alias する。
3. **run-job.mjs** がジョブごとに: ハーネスを git でリセット → `shadcn add <保存済みの item.json>` (名前空間なしの registryDependencies が公式レジストリに無ければ、同じ名前空間の兄弟として付け直して 1 回だけやり直す。例: 8bitcn の duel-block の `health-bar`) → アイテムが import しているのに宣言していない同じ名前空間の兄弟アイテムを追加 (例: 8bitcn の calendar が `./button` `./select` を import) → デモを書き込む → 宣言漏れの npm 依存を追加 (`--ignore-scripts`) → `vite build` (リモートフォントは data: URI に埋め込む) → `tsc` で demo.tsx だけの型エラーを集める。
4. **修正ループ**: lint 違反・ビルドエラー・デモの型エラーは、実際にインストールされたファイルの一覧を添えて LLM に返す (最大 2 回)。アイテム自身を import しないデモは lint で弾く (素の shadcn 部品に差し替えて通す「ずる」を防ぐ)。install の失敗はデモでは直せないので修正しない。
5. **撮影** (v0.5 からはコンテナ内の Playwright。§6.4): 16:10 のビューポート (中央寄せは 720×450、全幅は 1280×800、DPR 2) をそのまま撮る。全幅で組んだブロックが枠の 6 割未満の幅しかない場合 (設定パネルやランキングなどのウィジェット)、ハーネスが中央寄せに切り替え (`data-fit`)、撮影も 720×450 にする。要素ではなくビューポートを撮るのは、Radix のポータル (body 直下の dialog など) も写すため。描画時の例外 (pageerror・エラーバウンダリ) があればスクショを残さず build 段階の失敗にする。
6. **コンテナの運用**: `Sandbox` Durable Object + Containers (standard-1、最大 8)。コンポーネント ID のハッシュで 6 個のコンテナに振り分け、同じコンテナ内のジョブは `flock` で直列化する (ハーネスのディレクトリを共有するため)。コンテナの ID にはハーネスの内容のハッシュを入れ、さらに使う前にイメージに焼いた版 (`/opt/harness-version`) を確かめる。デプロイ直後はイメージのロールアウトが段階的 (本番で約 6〜10 分) で、新しい ID のコンテナでも古いイメージで起動することがあるため。版が違えば infra の一時障害として後で再試行する。`sleepAfter: 3m` で自動停止する。コンテナには LLM もシークレットも入れない。

- 生成した HTML はサイトのコンポーネントページで **Preview タブの本体** として iframe で動かす (読み込み中はスクショを表示)。信頼できない HTML なので `sandbox="allow-scripts"` (allow-same-origin なし) にし、配信時にも `CSP: sandbox` と `frame-ancestors 'self'` を付けて不透明オリジンで動かす。Code タブには実際にビルドした demo.tsx をそのまま出す。
- OpenAI キーか SANDBOX バインディングが無い本番環境では、プレビュー自体を計画しない (`capturePreviews=false`)。
- ローカル (`EXPLORER_MODE=local`) はフェイクのデモ・コンパイラで動く (Docker 不要)。

### 6.3 決まった手順は最小限に、長い尻尾はエージェントに (v0.4)

v0.3 で残った失敗 (本番 3 レジストリで 9 件) を 1 件ずつ条件分岐で直していくと、症状ごとのハックが積み上がる。v0.4 では Fable との壁打ちで線を引いた。

1. **決まった手順の核は小さく保つ** (run-job.mjs): ハーネスのリセット (`pnpm install --frozen-lockfile --offline` で前のジョブのパッケージを消し、どのコンテナで動いても同じ結果にする)、`shadcn add` (公式に無い名前空間なし依存は自分の名前空間で付け直す)、宣言漏れの兄弟アイテムと npm 依存の追加、`next/*` のスタブ (`next/font` は任意のフォント名を受ける Vite プラグイン)、フォントの埋め込み、枠のフィット。素の `shadcn add` から逸脱したら全部 `workarounds` として報告し、UI に出す。
2. **レジストリ固有の事情はデータ** (`RegistryPreviewConfig`): テーマを配布せず「globals.css に貼る」方式のレジストリのトークン (neobrutalism)、全アイテムの前に入れるアイテム、依存の固定。運営者がレジストリのページで編集でき、保存するとプレビューを作り直す。テーマ CSS のうちフォントの `@import` は別ファイルにして埋め込む。
3. **それでも直らないものはフォールバックの Coding Agent** (CF-Open-Agents-API)。成果物は HTML ではなく**ビルド手順** (`demo.tsx` + `manifest.json`)。こちらのコンテナで決定的に再実行するので、再現でき、ラベルを付けて表示でき、`BUILD_VERSION` を上げても手順を再利用できる (manifest はソースのハッシュに紐づく)。
   - エージェントのサンドボックスには同じハーネス (tar.gz、`scripts/bundle-harness.mjs` でビルド時に生成) を配り、`setup.sh` で同じ状態にする。`node /workspace/task/try.mjs` で試行錯誤させる
   - 委譲の条件: 原因が registry / demo / harness の build 失敗 (描画時の例外を含む) で、そのソース・版でまだ試していない。上限: レジストリあたり min(30, アイテム数 × 25%) 回、エージェント専用の月次予算 (既定 \$10)、遮断機 (10 回以上試して成功率 50% 未満のレジストリには回さない)。推論は medium (セッション作成時の `agent.reasoning.effort`。codex の `model_reasoning_effort` になる)
   - CF-Open-Agents-API は別 Worker の my-agents に置き、Service Binding `AGENTS` の `fetchAs` で呼ぶ (テナント `shadcn-explorer` をこちらが名乗るのでトークン不要)。プリセット `shadcn-explorer` は codex + gpt-6-luna (Responses のネイティブ接続、推論の強さはモデル側で固定しない)。同居させるとコンテナ 2 種・Durable Object 4 種・R2 バケット 2 つがこの Worker の管理対象に増えるので分けている
   - 記録: `preview_agent_runs` (結果・使った回避策)。同じ回避策が繰り返されたら、人が判断してレジストリのデータかハーネスの既定に格上げする。見る指標は「エージェントでビルドされた割合」が 0 に近づくこと
4. **それ以外は正直に失敗として出す**: registry 起因なら「公開されたままではビルドできない: 理由」、それ以外は「今はプレビューなし」。

失敗の原因はハーネスがエラーの位置から判定する (Rolldown の `╭─[ file` の位置。ハーネスのファイルが関わっていれば harness、デモか compat ファイルなら demo、レジストリが入れたファイルなら registry)。

### 6.4 撮影と動くサムネイル (v0.4、v0.5 でコンテナ内の Playwright に移した)

- 撮影はビルド用コンテナ内の Playwright + Chromium (`preview-harness/render.mjs`) で行う。v0.4 までは Browser Rendering (`@cloudflare/playwright`) だったが、録画 (recordVideo) が未対応で、スクショの連写は 1 枚に数百 ms 掛かるため動くサムネイルが早送りになった。コンテナに移したことで、録画が使え、ビルド直後の描画確認もできるようになった (コンテナは 2 vCPU の standard-3、イメージは約 4 GB)
- **ビルド直後の描画確認**: run-job.mjs がビルドした HTML を Chromium で開き、例外 (pageerror・ハーネスのエラーバウンダリ) を見る。例外は demo 起因のビルド失敗として修正ループ (とエージェント) に渡る。エージェントの試行 (`try.mjs`) も同じ確認を通る
- 静止画は `prefers-reduced-motion: reduce` で撮る (落ち着いた 1 コマ)。その後 `no-preference` で読み込み直し、0.5 秒おきの 7 コマ (3 秒) の差分で「動いている」かを判定する。1 秒おきの差分で画素の 0.3% 超が 2 回続く (文字の演出・背景。2〜3 秒かけて一度動いて止まる演出も含む) か、0.03% 超 (720×450 で約 100px。入力欄のカーソルの点滅より大きい) の小さな変化が 6 回中 4 回以上・最後の 2 回のどちらかで続く (スピナー・進捗リング) なら動く。cap-v6 で後者を足した (v5 までは小さなスピナーやまばらに変わるテキストの ai-loading などを見落としていた)。コードではなくピクセルで判定するので、setInterval 駆動のタイプライターも拾い、短い登場アニメーションだけのもの・ホバーでだけ動くものは静止扱いになる
- 動く部品は配色ごとに新しいページを開き、**読み込みの瞬間から**録画する (cap-v7)。`?theme=` 付きの URL で開くので最初のコマから正しい配色で描かれ、読み込み直後に一度だけ動く演出 (文字の解読・数字の流れ) も頭から撮れる (v6 までは判定の後から撮っていたので、演出が終わってから撮っていた)。レジストリのトークンは HTML 自体に埋め込むので、これも最初のコマから効く
- 録画の長さは、0.5 秒ごとに大きく動き続ける短いループなら 3 秒、それ以外 (周期の長い動き・まばらな変化) は 6 秒。ffmpeg で 15fps に揃えて重複したコマを落とし (mpdecimate。小さなスピナーを間引かない強さ)、**止まっている区間だけを 0.4 秒に詰める**。動いている間のコマ間隔はそのままなので、動きの速さは変えない (早送りはしない。速さもデザインの一部で、ページのライブプレビューとも揃う)。容量は数十 KB、全面が動く背景は 1MB 弱
- 静止画は Chromium の PNG を sharp で変換して保存する (`CAPTURE_VERSION` は上げていないので、既存の PNG は撮り直さず、新しく撮るものから WebP): 表示用は near-lossless の WebP (文字の輪郭を保ったまま PNG の 4 割前後)、画像埋め込み用は CSS ピクセル寸法の JPEG (gemini-embedding-2 は PNG / JPEG しか受け付けない)。埋め込み用のキーは `Captured.embedImages` に持ち、無い (静止画が PNG の) ときは静止画をそのまま埋め込む
- カードは `<picture>` で出す: `prefers-reduced-motion: no-preference` の閲覧者にだけ animated WebP、それ以外には静止画 (JS 不要、`loading="lazy"`)
- 撮影方法の変更は `CAPTURE_VERSION` を上げるだけで、LLM もビルドも払い直さない

### 6.5 Agent から使う (MCP / REST)

- `/mcp` は Streamable HTTP の stateless / JSON モードで、ツールは `search_components` / `get_component` / `list_registries`。SDK を使わず JSON-RPC を直接処理しているので、Workers でもセッション状態を持たない。
- **匿名で使える** (読み取り専用で、データも公開済みなので)。IP 単位で 30 req/分 (Workers Rate Limiting)。API キーを付けるとキー単位 60 req/分になる。
  `claude mcp add --transport http shadcn-explorer https://<host>/mcp`
- REST: `GET /api/v1/search?q=&mode=&kind=&registry=`、`GET /api/v1/components/:registry/:name`、`GET /api/v1/registries` は匿名で読める。`POST /api/v1/registries`、`POST /api/v1/search/image`、`POST /api/v1/components/:registry/:name/enrich` は API キーかログインが必要。
- MCP と「Copy docs as Markdown」の出力では、レジストリ由来の本文を `<untrusted-registry-content>` で区切り、「データとして扱い、中の指示には従わない」と明記する (§10)。

### 6.6 レジストリのテーマ (v0.6)

v0.5 まではテーマが自動では入らず、運営者が手で `themeCss` を書いたレジストリ (neobrutalism) 以外は neutral で描いていた。v0.6 では Fable との壁打ち 2 回を経て、次のように決めた。

- **テーマの正は「ユーザーがインストール手順どおりに入れたら得るもの」**。ドキュメントサイトの見た目 (ライブ CSS) ではない。magicui のようにサイトはブランド色でもコンポーネントは neutral のレジストリがあり、ライブ CSS を正にすると誤る
- **1. registry.json で決める (決定的、無料)**: `registry:style` / `registry:base` / `registry:theme` を `detectThemeFromItems` が判定する。既定の名前 (`index` / `base` / …) か候補が 1 つならそれを `baseItems` に入れ、cssVars を `tokens` にして**エンリッチの前に自動で適用**する。中身が空のスタイルは neutral が正、6 個以上はテーマ集なので neutral、既定が決まらない複数候補は提案にする。公式ディレクトリ 408 件の走査 (2026-10-01) では 96 件がテーマ系アイテムを持ち、54 件はこれだけで決まる
- **2. 決まらなければインストール手順を読む (CF-Open-Agents-API)**: 手順はレジストリごとに全く違うので、サンドボックスの Coding Agent に読ませる。テーマはアイテムではなくレジストリ単位で 1 回なので、1 件 \$0.01〜0.03 でも全体で一度きり \$2〜7。待つ間 (`AgentPending`、上限 30 分) はそのレジストリのプレビューを作らない (決まる前に作ると作り直しになる)
  - ドキュメントは先に読んで渡す: ホームページのリンクから install / theming などのページを決定的に選び、webforai platform で Markdown にして `/workspace/task/docs/` に置く (何を読んだかが確定し、根拠になる)。足りなければエージェントがサンドボックスで `webforai` CLI を使う。webforai は Service Binding `WEBFORAI` (`PlatformRpc.convert`、内部向けで課金なし) で呼ぶ
  - エージェントは同じハーネスで候補を代表アイテムに当て (`try-theme.mjs`)、ビルド・撮影して確かめる。成果物は `theme.json` (設定 + 根拠の引用 + 確信度)。こちらで `validateThemeConfig` (値の文法、`url()` / `@import` の拒否、`baseItems` はレジストリ自身のホストか名前空間だけ、`--background` と `--foreground` のコントラスト 3 以上) を通す。**v0.7 から承認は要らない**: 確信度が low でなく、根拠が 1 つ以上あれば適用する。満たさないものだけ neutral のまま `Proposed` として運営者の画面に残す。手順にテーマが無ければ neutral で確定する。おかしなテーマは閲覧者が GitHub Issues (`theme-report.yml`、ラベル `theme-wrong`) で報告する
- **設定はビルド時と実行時に分ける**: `tokens` (CSS 変数の値) は `@theme inline` 経由で `var()` を参照するので、ビルド済み HTML に注入して変えられる。名前 (`bg-main` を生成する `--color-main`)、フォント、`css`、`baseItems` はビルドが要る。既定のテーマはビルドに焼き、撮影時にも同じ値を注入する (`render.mjs`)。閲覧者はコンポーネントのページでレジストリのテーマ / 別テーマ (`variants`) / Neutral を切り替えられる (`preview:tokens`)。ダークを持たないテーマはライトだけ撮り、閲覧時もライトに固定する
- **作り直しは宣言的に、デモは書き直さない**: Built / Captured に `configHash` (ビルド設定) と `tokensHash` を持たせ、`planEnrichment` が違いを見て「ビルドし直す」か「撮り直すだけ」かを決める (v0.5 までの「保存時に全件 `NotCaptured` に戻す」はやめた)。ビルドし直すときは R2 に残っている同じソース・版のデモを使い、LLM を呼ばない。テーマの変更 1 件あたりはコンテナ代 (\$0.0015 前後)、トークンだけなら撮影代だけ
- 運営者が手で設定したテーマ (`Resolved{manual}`) は、registry.json が変わっても自動では上書きせず提案に留める。それ以外 (registry.json・エージェント由来) は自動で上書きする。ドキュメントの変化は追わない (「Re-detect」ボタンで判定し直す)
- ハーネスのトークンの文法 (`theme-tokens.mjs`) は core の `theme.ts` と同じ規則。値は色・長さ・`var()`・`calc()`・フォント名だけで、規則を開く・外部を参照する・`<style>` を閉じることはできない。テーマ用アイテムが入らなくてもビルドは止めず、`registry-base-failed` として報告する

### 6.7 モデルの選び方と OpenAI の無料枠 (v0.7)

組織でデータ共有を有効にしていると、OpenAI の無料枠 (Complimentary daily tokens) が使える。モデル群ごとに 1 日の上限があり (gpt-6-luna などの群 1M、gpt-5.6-luna などの群 10M)、input と output (reasoning 込み) を数え、00:00 UTC にリセットされる。上限をまたいだリクエストは全体が通常料金になり、残量を返す API やヘッダは無い。

- **ステップごとのモデル** (`LlmRouting`、`packages/core/src/domain/llm-routing.ts`): ドキュメントは `gpt-5.6-luna`、デモは `gpt-5.6-luna`、修正は `gpt-6-luna` を先に使う。品質は `evals/models/` で比べた (24 件の通常アイテムと、過去に失敗した・エージェントが直した 31 件の難しいもの)。ドキュメントは同等以上 (props と examples が多い)、デモは「5.6 で書き、修正は 6-luna」が 6-luna だけと同じ 24/31 で、落ちた 6 件はレジストリ側の問題だった
- **数え方**: `usage_records` に `model` 列を足し、UTC の日 × モデル群でトークン数を合計する (`tokensByModelSince`)。群の上限 × 0.9 − 余裕 (30k、1 リクエストの最大) を超えたら次の候補のモデルへ、全部使い切ったら `Pause` (既定。エンリッチを翌日に回し、backlog sweeper が拾い直す) か `Paid` (`gpt-6-luna` を有料で)。無料で使った分は 0 円で記録する
- 待つかどうかは計画で決める: ドキュメントのモデルが無ければコンポーネントごと `Defer`、デモだけ無ければプレビューだけ後回し (`Degrade`)。計画の後に使い切った場合は、計画で許した呼び出しは優先のモデルで続ける (途中で止めて失敗にしない)
- **費用の見通し** (Fable の試算): 1 件の LLM は約 8k tokens・有料なら \$0.0017 で、2.7 万件全部でも約 \$46。律速はコンテナ (\$0.0063 / 件のうち LLM は 1/4)。無料枠の 9 割だけで回すと、5.6-luna 側で 1 日約 1,150 件・全件で約 24 日 (6-luna の 1M 群が修正で埋まると先に頭打ちになる)。全部有料なら約 4 日
- ドキュメントの `examples` は Structured Outputs のスキーマで 1〜4 件を必須にした (プロンプトの指示だけでは半数以上が空だった)

### 6.8 生成過程の公開ログ (v0.7)

コンポーネントのページの「See how it was built」、レジストリのページの Build log、全体の `/live` で、生成の流れをほぼリアルタイムに見せる。

- `pipeline_events` (D1、追記だけ、30 日で消す)。書くのは状態を保存する地点 (同期・テーマ・計画・ドキュメント・デモ・ビルド・修正・エージェント・撮影・インデックス) で、`emit` はログの失敗で生成を止めない
- 公開してよいものだけを載せる: ステップ・所要時間・試行回数・回避策の数・デモのコード (Code タブで既に公開)・スクショのキー・ビルドエラーの 1 行目。金額・プロンプト・LLM の生のエラー・エージェントの会話は載せない
- 配信はポーリング: `GET /api/live/events?component=|registry=&after=` と `GET /api/live/summary`。匿名のレート制限の外に置き、同じ URL をエッジで 2 秒キャッシュして D1 への読みをまとめる (Durable Object の WebSocket は閲覧者が増えたら)
- Workflow のステップが永続化エラーで再実行されると同じイベントが 2 回入ることがある (画面側で畳む)。計画のイベントは Workflow の計画ステップでだけ出す (backlog sweeper とキューの消費者の事前の計画では出さない)

## 7. 検索設計

### 7.1 バックエンド (v0.2 で再構成)

| モード | ソース | バックエンド | 得意なこと |
| --- | --- | --- | --- |
| keyword | `keyword` | **D1 FTS5 `bm25()`** (trigram。既定)。`TEXT_SEARCH_BACKEND=ai-search` で AI Search の BM25 に切り替え可 | 固有名詞、パッケージ名、型名 |
| semantic | `semantic` | クエリ埋め込み × Vectorize の **doc ベクトル** (`modality = doc`) | 言い換え、用途からの検索 |
| visual | `visual-text` / `visual-image` | 同じクエリ埋め込み (または画像埋め込み) × Vectorize の **スクショベクトル** (`modality ∈ {light, dark}`) | 見た目の形容 ("かっこいい")、画像から画像 |
| hybrid (既定) | 上の全部 | RRF で融合 | 総合 |

v0.1 からの変更点:
- **埋め込みを gemini-embedding-2 の 1 系統に統一した**。v0.1 は同じ Markdown を AI Search (gemini-embedding-001) と Vectorize (gemini-embedding-2) で二重に埋め込んでいた。
- **modality で絞る**。マルチモーダル空間ではテキスト同士の類似度がテキストと画像の類似度より高い (modality gap)。絞らないと、ビジュアル検索の上位がドキュメントのテキストベクトルで埋まり、実質的に意味検索と同じリストを RRF に二重投入していた。
- クエリの埋め込みは 1 回だけ計算し、semantic と visual で共有する。
- BM25 を D1 FTS5 に寄せた理由: ドキュメントは 2k トークン程度でチャンク化が要らない。AI Search はベータで、アイテム上書きの挙動も未確認。ポートはそのままなので、いつでも戻せる。

- 埋め込みの指示はプレフィックスで行う (task type パラメータは廃止された)。クエリは `task: search result | query: …`、文書は `title: … | text: …`。
- **融合 (RRF)**: 各バックエンドのスコアはスケールが違うので、順位だけで融合する。

$$
\mathrm{score}(d) \;=\; \sum_{i \in \text{sources}} \frac{w_i}{k + \mathrm{rank}_i(d)}, \qquad k = 60
$$

  重みは今は仮置き ($w_{\text{keyword}} = 1.2$、$w_{\text{semantic}} = 1.0$、$w_{\text{visual-text}} = 0.9$、$w_{\text{visual-image}} = 1.0$)。§7.3 の評価で決める。
- バックエンドの一部が失敗しても残りで結果を返し、失敗は `warnings` として返す (劣化運転)。

### 7.2 日本語

- D1 FTS5 は `tokenize='trigram'`、インメモリ BM25 は CJK 文字 bi-gram を使う。
- ただし trigram でも、**英語のドキュメントに日本語のクエリは当たらない** (評価で BM25 の日本語 MRR が 0 だった)。対策は 2 つ。
  1. ドキュメント生成時に `keywords` へ日本語の同義語 (例: ボタン、ドット絵、アニメーション背景) を含めさせる。
  2. クエリの日本語部分は空白で区切られないので、3 文字の窓に分けて OR で検索する (`toTrigramQuery`)。
  意味検索 (gemini-embedding-2 は多言語) と合わせて hybrid で拾う。

### 7.3 評価

- `packages/core/eval/golden.json` にゴールデンセット (24 クエリ: 固有名、説明的、意味的、日本語、見た目) を置き、`pnpm --filter @shadcn-explorer/core eval:search -- --base <url>` でモード別・タグ別に recall@10 と MRR を出す。
- ローカルでの結果 (BM25 は本物、semantic と visual はフェイクのハッシュ埋め込みなので参考外):

149 件 (`@23rd` 28 + `@8bitcn` 121) を `gpt-6-luna` で生成・インデックスした後の値。日本語対策 (§7.2) は 2 段階で効いた。

| mode | R@10 | MRR | MRR 固有名 | MRR 説明的 | MRR 意味的 | MRR 日本語 | MRR 見た目 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| keyword (BM25) | 0.843 | 0.847 | 0.857 | 1.000 | 0.857 | **0.454** | 0.688 |
| semantic (fake) | 0.764 | 0.682 | 0.767 | 0.833 | 0.525 | 0.136 | 0.575 |
| visual (fake) | 0.721 | 0.674 | 0.857 | 0.929 | 0.553 | 0.044 | 0.304 |
| **hybrid** | **0.864** | **0.872** | 0.929 | 1.000 | 0.743 | 0.357 | 0.786 |

経緯 (BM25 の日本語 MRR):
1. 生成前 (大半が未インデックス): hybrid の MRR 0.698、BM25 の日本語 MRR は 0。
2. 全件を生成し、keywords に日本語を含めた後: hybrid 0.824。BM25 の日本語はまだ 0。原因はクエリ側で、空白の無い日本語 ("ドット絵のボタン") が 1 つの長いフレーズになり、連続一致しないと当たらなかった。
3. クエリの日本語部分を 3 文字の窓に分けて OR にした後: BM25 の日本語 0.454、hybrid 0.872。

- 重みの決定と「スクショベクトルが実際に効いているか」の判断は、本物の gemini-embedding-2 とコンテナでの撮影の環境でこの評価を回してから行う。

### 7.4 表示速度 (v0.7)

2026-10-01 の計測で、TTFB はホーム 0.5〜1.8 秒、検索 0.8〜2.3 秒だった (同じ Worker の `GET /api/v1/registries` は 0.26 秒)。主因は埋め込みではなく D1 で、Fable と切り分けた。

- **D1 が遠い**: プライマリは ENAM で、日本から 1 往復 150〜250ms。公開の読み取り (検索・ギャラリー・詳細・レジストリ一覧・REST・MCP) は D1 Sessions API (`withSession("first-unconstrained")`) の読み取りレプリカに回す (`runRead`)。Workflow・キュー・cron・運営者の操作はプライマリのまま (前のステップの書き込みを別の isolate から読むので、レプリカの遅れで状態を読み違えると生成をやり直してしまう)。詳細ページの 4 往復は並列にした
- **カードに JSON 全体をデコードしていた**: 48 件で 355KB を読み、行ごとに Schema でデコードしていた (1 件約 10ms)。カードは列と `json_extract` だけで組み立てる (`listCards` / `findCards` / `gallery`)。検索の結果もこれで引く
- **ホームのバグ**: 全件を `registry_id, name` 順に 48 件だったので、8bitcn の先頭 48 件しか出ていなかった。ギャラリーは `content_hash` 順 (レジストリをまたいで混ざる安定した並び) の keyset ページングにした (`preview_tag` / `has_motion` 列を非正規化、0006)
- **検索の段階表示**: キーワード (BM25) の一致を SSR で先に出し、意味・見た目で近いものは下の別枠に後から足す。先に出た並びは組み替えない。クエリの埋め込みは isolate の LRU と Cache API に 30 日キャッシュする
- **スクショ**: cap-v8 からキーに見た目の設定の版 (`variant` = configHash + tokensHash) を入れたので中身が変わらない。`/media` で `immutable` にし、エッジの Cache API から返す。プレビューの HTML とそれ以前のスクショは 1 時間 + ETag のまま
- ログイン中の閲覧者のセッションは Better Auth の cookie cache (5 分) で D1 を引かない

## 8. 認証・認可

| 利用者 | 識別 | できること | 制限 |
| --- | --- | --- | --- |
| Web UI | Better Auth のセッション Cookie (GitHub OAuth / メール) | 閲覧、API キー発行。運営者 (`ADMIN_USER_IDS`) だけが登録・再同期・再生成・プレビュー設定・コストの閲覧 (/admin) | — |
| 外部クライアント・Agent | `x-api-key` (`sce_…`) | 読み取り + 書き込み | キー単位 60 req/分 (Better Auth api-key) |
| 匿名 | IP | 読み取り (REST GET / MCP) | IP 単位 30 req/分 (Workers Rate Limiting) |

- server fn では `*.server.ts` に置いた `requireUserId()` で確認する (クライアントバンドルに入らない)。

## 9. コスト設計

### 9.1 単価の前提 (2026-09 時点)

| 項目 | 単価 |
| --- | --- |
| gpt-6-luna | \$0.10 / 1M input、\$0.01 / 1M cached input、\$0.50 / 1M output ([公式](https://developers.openai.com/api/docs/pricing)) |
| ビルド・撮影用コンテナ | Containers standard-3 (2 vCPU・8 GiB) ≈ \$0.00006 / 秒。ビルド 1 件約 15 秒 (描画確認込み)、撮影 4〜12 秒 |
| フォールバックの Coding Agent | gpt-6-luna (medium) のトークン分。本番の実測で 1 件約 \$0.0036・2〜3 分 (決まった手順で直せなかったものだけ) |
| gemini-embedding-2 | テキスト \$0.20 / 1M tokens、画像 約 \$0.00012 / 枚 (Batch API なら半額) |
| Vectorize | 保存 10M 次元まで無料、以降 \$0.05 / 100M 次元。クエリ 50M 次元まで無料、以降 \$0.01 / 1M 次元 |
| D1 / R2 / Workflows | 本用途では無料枠か誤差の範囲 |

### 9.2 1 コンポーネントあたりの初回コスト

ドキュメントは本番の実測値、プレビュー (デモ生成 + ビルド) はローカルと本番の実測に基づく見込み (約 20k input tokens、うち 8k がキャッシュ、4k output、コンテナ 30 秒。修正ターンの期待値込み)。

$$
C_{\text{doc}} = \frac{5{,}500 \times 0.10 + 1{,}900 \times 0.50}{10^6} \approx \$0.0015 \quad (\text{実測})
$$

$$
C_{\text{preview}} \approx \frac{12\text{k} \times 0.10 + 8\text{k} \times 0.01 + 4\text{k} \times 0.50}{10^6} + 30 \times 0.00002 \approx \$0.004 \quad (\text{見込み。v0.2 は } \$0.033)
$$

$$
C_{\text{item}} = C_{\text{doc}} + C_{\text{preview}} + C_{\text{browser}} + C_{\text{emb}} \approx 0.0015 + 0.004 + 0.0002 + 0.0006 \approx \$0.0063
$$

- v0.2 の見込み (\$0.035) から約 **5 分の 1** になった (v0.1 の \$0.121 からは約 20 分の 1)。プレビューを汎用の Coding Agent から「LLM 1 回 + 決定的なビルド」に変えたため。
- 規模ごとの目安:
  - 500 件のレジストリ: プレビュー込み $\approx \$3$、ドキュメントだけなら $\approx \$1$
  - 公式ディレクトリ全体 (約 19k 件と仮定): プレビュー込み $\approx \$120$、ドキュメントだけなら $\approx \$40$

### 9.3 継続コスト

- 再同期は `contentHash` が同じなら **\$0**。変更率を $r$ とすると、月次コストは $\approx r \cdot N \cdot C_{\text{item}}$。
- 検索 1 回あたりは Gemini のクエリ埋め込み 1 回 (約 20 tokens ≈ \$0.000004) と Vectorize クエリ 2 回。Vectorize のクエリ次元は $(V_{\text{stored}} + Q) \times d$ で課金される。例: $V = 57{,}000$ ベクトル、$Q = 100{,}000$ クエリ/月、$d = 1536$ で、無料枠を超えた分が \$2 程度/月。匿名アクセスを許しても、IP 単位のレート制限で上限が決まる。

### 9.4 コスト制御の仕組み

1. **ハッシュによるスキップ**: ソースが変わったときだけ生成する。
2. **予算ガード** (`MONTHLY_BUDGET_USD`): ソフトリミット 80% を超えたらプレビュー (デモ生成・ビルドと Browser) を後回しにして、ドキュメントとインデックスは続ける (`Degrade`)。100% を超えたら何もしない (`Defer`)。後回しにしたものは翌月以降に backlog sweeper が拾う。
3. **実測の台帳**: `usage_records` に**実トークン数 × 単価**を記録する。失敗した呼び出しも見積もり額で記録する。`registry_id` 列で帰属を持ち、レジストリ別に集計できる。当月のコストは管理画面 (/admin) にだけ出す。
4. **件数の上限**: 1 レジストリ 500 件。登録は運営者だけ (v0.6)。
5. **失敗の上限**: 同じソースで 3 回失敗したら、ソースが変わるまで諦める (段階ごとに独立して数える)。
6. **並列度の制限**: エンリッチのキューの `max_concurrency` (wrangler.jsonc、既定 4)。v0.5 までの `ENRICH_PARALLELISM` は投入 1 回ごとの並列度で、全体の上限になっていなかった (一斉登録で数百本の Workflow がコンテナを取り合う)。
7. 非ビジュアルな kind (hook/lib/file) はプレビューを作らない。
8. OpenAI の無料枠を日次で数え、9 割で止める (§6.7)。
9. AI Gateway を通す場合 (`OPENAI_BASE_URL` / `AI_GATEWAY_TOKEN`)、ゲートウェイの spend limit (モデル別・日次のドル建て) をアプリ側の判断の外側の歯止めとして設定しておく。リクエストには `cf-aig-metadata` (registry, step) を付ける。

今後の改善案: 埋め込みを Gemini Batch API に寄せる (半額)。`filesHash` (ファイル内容だけのハッシュ) で、レジストリをまたいだ同一コードを検出してドキュメントを使い回す。人気のないレジストリはプレビューを遅延生成する。

## 10. セキュリティ

- **SSRF**: https のみ許可し、IP リテラル、`localhost`、`.internal`、認証情報付き URL は拒否する。サイズ上限とタイムアウトも設けている。
- **プロンプトインジェクションの伝播対策**: レジストリの内容は信頼できない入力で、それを読んだ LLM の出力を利用者の Coding Agent に渡す経路がある。
  - Agent 向けプロンプトは LLM に書かせず、`agentPromptFor` がインストールコマンド・props・usage からテンプレートで**決定的に**組み立てる。生成物は「参考データ」として区切って埋め込む。
  - MCP と Markdown の出力では、レジストリ由来の本文を `<untrusted-registry-content>` で区切る。
  - `scanUntrustedText` が危険な兆候 (curl パイプ sh、指示の上書き、`rm -rf`、base64 デコード、sudo、秘密情報の送信) を検出し、UI と MCP で警告する。
  - プレビューのビルドに Agent は使わない。コンテナで動くのは信頼できる run-job.mjs だけで、レジストリの npm 依存は `--ignore-scripts` でインストールする (vite / tsc はアイテムのコードを実行しない)。コンテナには LLM もシークレットも入れない。
  - コンテナからの外向き通信は制限していない (`shadcn add` と npm のため)。秘密情報を持たないこと、ジョブごとのタイムアウト、`sleepAfter` による停止で影響を抑える。
- **フォールバックの Coding Agent**: 別の Worker (CF-Open-Agents-API) の使い捨てサンドボックスで動き、こちらのシークレットを持たない。返すのはビルド手順 (データ) だけで、許可リスト外の操作・`src/compat` 外への書き込み・6 個以上の依存追加は採用しない。アイテムのインストールはこちらのコンテナで行うので、アイテム本体は構造的に改変されない。回避策は UI にラベルとして出す。
- **生成 HTML**: 不透明オリジンのサンドボックスで実行し、CSP で外部通信を禁止する (`frame-ancestors 'self'` で他サイトへの埋め込みも禁止)。撮影時もネットワークを遮断している。フォントはビルド時に data: URI へ埋め込む。
- **FTS インジェクション**: クエリの各トークンをフレーズ化して、演算子を無効化する。
- **ログイン後のリダイレクト**: 同一オリジンのパスだけを許可する。
- **アップロード**: PNG/JPEG をマジックナンバーで判定し、4MB 上限。`uploads/` は非公開で、R2 のライフサイクルルールにより 1 日で削除する。

## 11. 現状と TODO

**v0.4 / v0.5 で対応したこと** (Fable との壁打ちを経て)
- 決まった手順の核を小さく保ち、レジストリ固有の事情はデータ (`RegistryPreviewConfig`)、長い尻尾はフォールバックの Coding Agent (ビルド手順を返させて、こちらで決定的に再実行) に寄せた (§6.3)
- 失敗の原因 (registry / demo / harness / infra) で再試行・委譲・表示を分けた。ハーネスのリセットで前のジョブのパッケージを消すようにした (どのコンテナでも同じ結果)
- 動くサムネイル (§6.4)。撮影をコンテナ内の Playwright に移し、録画から実時間の animated WebP を作る。ビルド直後の描画確認で、描画時の例外も修正ループに乗るようにした
- `BUILD_VERSION` と `CAPTURE_VERSION` の分割 (撮影だけの変更で LLM・ビルドを払い直さない)
- コンテナのイメージのロールアウト待ち対策 (イメージに焼いた版を確かめる)

**本番での実測 (v0.5、2026-09-29)**: 3 レジストリのビジュアルなアイテム 221 件
- **221/221 件にプレビュー** (8bitcn 121、kokonutui 46、neobrutalism 54)。v0.3 の時点で失敗していた 9 件は、決まった手順 (描画確認と修正ループ) と、エージェントの 5 件で全て解消した
- エージェントの 5 件は全て成功し、回避策は「ユーザーがやるであろうこと」だった: 同梱漏れの `retro.css` のスタブ (2 件)、`@tanstack/react-table` を v8 に固定、ブランドアイコンが残っている旧版の `lucide-react`、同梱漏れの `use-mobile` フックのスタブ。1 件あたり約 \$0.0036・2〜3 分
- 動くサムネイルは 13 件 (タイプライター、グラデーションの流れるボタンなど)。WebP は数十 KB で、実時間で再生される
- neobrutalism はテーマのトークン (影・色・フォント) をレジストリのプレビュー設定に入れて作り直し、本来の見た目になった
- この日の作業全体 (撮り直し 3 回、neobrutalism の作り直し、エージェント 5 件) の実費は約 \$0.74 (埋め込み \$0.36、コンテナ \$0.20、LLM \$0.09、旧 Browser Rendering \$0.09、エージェント \$0.01)

**v0.3 で対応したこと** (プレビューの作り直し。Fable との壁打ちを経て)
- プレビューを「汎用 Coding Agent がデモを作ってビルド」から「LLM 1 回でデモ (`demo.tsx`) を書く + コンテナのハーネスで決定的にビルド + 最大 2 回の修正」に変えた (§6.2)。ports は `PreviewBuilder` (start / poll) をやめ、`DemoWriter` と `PreviewCompiler` に分けた
- サムネイルを ui.shadcn.com のデモと同じ粒度にした。枠はハーネスが持ち、見出し・偽のアプリ枠などは禁止 + lint で機械的に弾く
- コンポーネントページの Preview タブを iframe のライブデモにし、Code タブに実際にビルドしたデモを出す。テーマはサイトと同期
- 生成方式の版 (v0.4 で `BUILD_VERSION` と `CAPTURE_VERSION` に分割) をプレビューの鮮度キーと R2 キーに入れた。上げるだけで backlog sweeper が作り直す

**本番での実測** (2026-09-29、`@8bitcn` 121 件を `demo-v2` で作り直し。4 並列の Workflow で約 32 分)
- 116/121 (96%) 成功。失敗 5 件の内訳は、コンテナの一時的な HTTP 500 が 1 件 (再試行で回復)、レジストリ側の不具合が 4 件 (依存のバージョン未指定で `@tanstack/react-table` v9 が入る、同梱されていない `retro.css` を import している × 2、`nuqs` のアダプタが必要)
- コスト: デモの LLM \$0.080 (132 回、72 万 input / 6.2 万 output tokens)、コンテナ \$0.067 (126 回)、撮影 \$0.018。**プレビューは 1 件あたり約 \$0.0014** (v0.2 の見込みは \$0.033、実際は 75% が失敗)
- 1 件あたりの所要時間: デモ生成 7〜9 秒、ビルド 15〜25 秒 (コールドスタートとロック待ち込み)、撮影 約 10 秒

**v0.2 で対応したこと** (Fable によるアーキテクチャレビューの指摘を受けて)
- エンリッチの失敗をコンポーネント単位・ステップ単位で隔離した。item 原本を R2 に保存し、再取得をやめた
- backlog sweeper (日次)。予算で後回しにされたものや一時失敗が放置されなくなった
- ドキュメント (`gpt-6-luna` 1 回呼び出し) とプレビュー (サンドボックス、2 段階) に分けた
- 検索を再構成した (BM25 は D1 FTS5、意味検索とビジュアル検索は modality を分けた Vectorize、埋め込みは 1 系統)
- 実測ベースの台帳、コストの帰属、ユーザー別の月次上限
- Agent 向けプロンプトの決定的な生成、信頼できない内容の区切り表示、危険な兆候の検出
- 匿名での読み取りと MCP (IP 単位のレート制限)
- 検索の評価ハーネスとゴールデンセット

**ローカルでの E2E 確認** (`EXPLORER_MODE=local`、実在レジストリ `@23rd` と `@8bitcn`、ドキュメントは本物の `gpt-6-luna`)
- 登録 (namespace 指定とサイト URL からの自動発見)、同期、エンリッチ、検索、MCP、匿名のレート制限 (31 回目で 429)、匿名の書き込み拒否
- `gpt-6-luna` による 20 件の実生成: 20/20 成功、平均 \$0.0015 / 件、約 14 秒 / 件
- cron (再同期 + backlog sweeper) で未完了分を拾い直せることを確認: 残り約 130 件を処理し、全 149 件中 148 件の生成に成功。残る 1 件は、修正前の不具合で 1 回失敗していたもので、次回のスイープで再試行される
- 検索の評価: hybrid で recall@10 0.864 / MRR 0.872 (§7.3)

**v0.6 で対応したこと** (一般公開の準備。Fable との壁打ちを経て)
- 登録・再同期・再生成・プレビュー設定を運営者だけに (`ADMIN_USER_IDS`)。一般ユーザーの追加は GitHub Issues で受け付け、最低限の管理画面 (/admin) を作った
- エンリッチを Cloudflare Queues に (全体の同時実行数を `max_concurrency` で制限、D1 の lease で重複を除く)。同期でアイテムの取得に失敗しても削除扱いにしない
- レジストリのテーマ (§6.6)。ローカルの実在レジストリ (`@delego`、`registry:theme` が 1 つ) で、登録 → テーマの自動適用 → 管理画面・テーマの切り替え UI まで確認。エージェントの経路は本番の my-agents では未検証

**v0.7 で対応したこと** (体験とライフサイクル。Fable との壁打ち 3 回を経て)
- デザインシステム "Zinc / Signal" (Zinc + 差し色 1 色の橙、Geist / Geist Mono、ドットグリッドの stage)。デザインキャンバス: https://claude.ai/artifact/Rd4fxrqN1s7qszASVsEAfN
- ギャラリー優先のホーム、⌘K、段階表示の検索、シンタックスハイライト (sugar-high)、レジストリをまたいだ似たコンポーネント、ビルドログ、`/live`、管理画面のライフサイクル
- 公式ディレクトリの自動取り込み、7 日ごとの再同期、テーマの全自動化、GitHub Issues の報告フォーム (`preview-broken` / `theme-wrong`)、運営者の作り直し
- 無料枠を使うモデルの選び方 (§6.7)、公開ログ (§6.8)、表示速度 (§7.4)
- 撮影の不具合: 動く部品の静止画が animated WebP で上書きされていた (同じファイル名)。cap-v8 で直し、撮り直す
- 監視: トレースは 5%、Issues を有効、10 分ごとの見張り (キューの詰まり・期限切れの lease・ビルド失敗の急増)。Cloudflare には Queues / Workflows / Containers の通知が無いので自前

**shadcn/ui 自身** (2026-10-02): `/r/index.json` は配列だが、`/r/styles/new-york-v4/registry.json` は正規の registry.json (471 件) なので、ディレクトリに `@shadcn` の項目を足して公式として扱う (`SHADCN_UI_ENTRY`)。件数が分からないので自動の取り込みには乗らず、運営者が `@shadcn` で登録する

**次にやること**
1. エージェントの回避策の格上げの運用: `preview_agent_runs` を見て、同じ回避策がレジストリ内で繰り返されたらレジストリのプレビュー設定へ、レジストリをまたいで繰り返されたらハーネスの既定へ (人が判断する)
2. 本物の gemini-embedding-2 と Vectorize の環境で §7.3 の評価を回し、RRF の重みと、スクショベクトルが効いているかを判断する
3. `filesHash` によるレジストリ横断の重複検出 (ドキュメントの使い回しと、検索結果の折り畳み)
4. デプロイ手順書 (D1 / R2 / Vectorize のメタデータインデックス `registry_id`・`kind`・`modality` / Rate Limiting / シークレット)
5. R2 のアイテム原本を `/r/{registry}/{name}.json` で配信する (レジストリが落ちていても `shadcn add` と MCP が動く)。コンポーネントの変更履歴 (contentHash の差分)

## 12. セットアップ (抜粋)

```bash
pnpm install
cd apps/web && cp .dev.vars.example .dev.vars   # EXPLORER_MODE=local
pnpm db:migrate:local && pnpm dev               # http://localhost:3000
pnpm -r test                                     # core の単体テスト

# 本番リソース
wrangler d1 create shadcn-explorer-v2
wrangler r2 bucket create shadcn-explorer-v2-media
wrangler vectorize create shadcn-explorer-v2-visual --dimensions=1536 --metric=cosine
wrangler vectorize create-metadata-index shadcn-explorer-v2-visual --property-name=registry_id --type=string
wrangler vectorize create-metadata-index shadcn-explorer-v2-visual --property-name=kind --type=string
wrangler vectorize create-metadata-index shadcn-explorer-v2-visual --property-name=modality --type=string
# (任意) TEXT_SEARCH_BACKEND=ai-search にする場合だけ AI Search インスタンス "shadcn-explorer" を作る:
#   組み込みストレージ、index_method {keyword}、trigram、custom_metadata: component_id, registry_id, kind
wrangler queues create shadcn-explorer-enrich
wrangler secret put BETTER_AUTH_SECRET   # 以下同様: OPENAI_API_KEY GEMINI_API_KEY GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
# テーマのエージェントに渡すドキュメントは webforai platform の PlatformRpc (Service Binding WEBFORAI) で読む。webforai-platform を先にデプロイしておく
# v0.7: D1 の読み取りレプリカを有効にする (ダッシュボードの D1 → Settings → Read replication、または API)。
#   有効にしなくても動く (セッションは全部プライマリに行く)
# v0.7: Workers Observability → Issues で通知先 (Webhook など) を設定する。見張りの cron が console.error で異常を出す
wrangler secret put ADMIN_USER_IDS       # 運営者の Better Auth ユーザー ID (カンマ区切り)。一度ログインしてから:
#   wrangler d1 execute shadcn-explorer-v2 --remote --command "select id, email from user"
pnpm db:migrate:remote && pnpm deploy
```

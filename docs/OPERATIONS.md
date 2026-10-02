# 運営・デプロイ

README から移した運営者向けの情報。設計は [DESIGN.md](DESIGN.md)。

## 運営 (管理画面)

申請の取り込み・再同期・作り直し (ドキュメント / プレビュー / 両方)・プレビュー設定・テーマの確認・当月コストの閲覧は、`ADMIN_USER_IDS` (Better Auth のユーザー ID、カンマ区切り) に入っているユーザーだけができる。管理画面は `/admin` で、公式ディレクトリの取り込み状況・申請 (GitHub Issues の `registry-request`)・再同期の予定も見られる。

1. 一度ログインしてユーザーを作る
2. ID を調べる: `wrangler d1 execute shadcn-explorer-v2 --local --command "select id, email from user"` (本番は `--remote`)
3. ローカルは `.dev.vars`、本番は `wrangler secret put ADMIN_USER_IDS` に入れる

REST の `POST /api/v1/registries` と `POST /api/v1/components/:registry/:name/enrich` も、運営者の API キーでだけ通る。

## テスト・評価

```bash
pnpm -r test                          # core の単体テスト (インメモリ Layer)
pnpm -r typecheck
pnpm --filter @shadcn-explorer/core eval:search -- --base http://localhost:3000 --cookie "<session cookie>"
```

## LLM と OpenAI の無料枠

ドキュメントとデモは `gpt-5.6-luna`、デモの修正は `gpt-6-luna` を先に使う (品質の比較は `evals/models/`)。組織でデータ共有を有効にしていると使える無料枠 (Complimentary daily tokens。モデル群ごとに 1 日の上限、00:00 UTC にリセット) を、`usage_records` の実トークン数で数えて 9 割まで使う。使い切った後は既定で翌日まで待つ (`LLM_OVERFLOW=paid` で `gpt-6-luna` を有料で使って続ける)。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `OPENAI_DOC_MODELS` / `OPENAI_DEMO_MODELS` / `OPENAI_REPAIR_MODELS` | `gpt-5.6-luna,gpt-6-luna` / `gpt-5.6-luna,gpt-6-luna` / `gpt-6-luna,gpt-5.6-luna` | ステップごとのモデルの優先順 |
| `FREE_QUOTA` | (on) | `off` で無料枠を数えない |
| `FREE_QUOTA_1M` / `FREE_QUOTA_10M` | 1,000,000 / 10,000,000 | 群ごとの 1 日の上限 (Tier 1-2 は 250k / 2.5M) |
| `FREE_QUOTA_RATIO` | 0.9 | 使う割合 |
| `LLM_OVERFLOW` | `pause` | 使い切った後: `pause` / `paid` |
| `DIRECTORY_INTAKE` / `DIRECTORY_INTAKE_PER_RUN` / `DIRECTORY_INTAKE_MAX_BACKLOG` | on (local は off) / 10 / 1000 | 公式ディレクトリの取り込み |
| `RESYNC_INTERVAL_DAYS` / `RESYNC_PER_RUN` | 7 / 60 | 再同期の間隔と 1 晩の上限 |
| `SPONSOR_SLOT` | なし | ギャラリーのスポンサー枠 (JSON: `title` `registry` `href` `image`) |
| `REGISTRY_REQUEST_EMAIL` / `GITHUB_TOKEN` | なし | 申請をメールでも受ける宛先 / 管理画面で申請の Issue を読むトークン |

## 監視

`wrangler.jsonc` の `observability` でログは全件、トレースは 5% (トレースのスパンもログとして課金されるため)、Issues を有効にしている。10 分ごとの cron (`src/infrastructure/pipeline-watchdog.ts`) が、キューの詰まり・期限切れの lease・ビルド失敗の急増を `console.error` に出すので、ダッシュボードの Workers Observability → Issues で通知先を設定しておく (本番はメール inaridiy@sfc.wide.ad.jp)。

## デプロイ

手順の抜粋は [DESIGN.md §12](DESIGN.md) にある。D1 / R2 / Vectorize (メタデータインデックス `registry_id` `kind` `modality`) / Queues (`shadcn-explorer-enrich`) を作り、シークレット (`BETTER_AUTH_SECRET` `OPENAI_API_KEY` `GEMINI_API_KEY` `ADMIN_USER_IDS` ほか) を設定し、`pnpm db:migrate:remote` を流してから `pnpm deploy` する。デプロイ時にプレビュー用コンテナのイメージ (`preview-harness/Dockerfile`) をビルドして push するので、**Docker が必要**。

プレビューの生成方式を変えたら `packages/core/src/domain/demo.ts` の版を上げる。日次の backlog sweeper が拾い直す。

- `BUILD_VERSION`: ハーネス・デモのプロンプト・ビルド手順を変えたとき。全件がデモ生成から作り直しになる
- `CAPTURE_VERSION`: 撮影方法 (枠・動くサムネイル) を変えたとき。既存の HTML を撮り直すだけ

決まった手順で直せないプレビューは、フォールバックの Coding Agent ([CF-Open-Agents-API](https://github.com/inaridiy/CF-Open-Agents-API)) にビルド手順を書かせる。API は別 Worker の my-agents にあり (プリセット `shadcn-explorer`、テナント `shadcn-explorer`)、Service Binding `AGENTS` で呼ぶ。無くても動く (直せないものは失敗として表示される)。レジストリ固有の事情 (テーマのトークン・依存の固定など) は、レジストリのページの「Preview settings」(運営者のみ) にデータとして書く。

テーマの判定 ([DESIGN.md §6.6](DESIGN.md)) は同期のたびに走る (registry.json のテーマ系アイテムが変わったときだけ)。確信度の低いエージェントの提案だけが管理画面の「Theme」に残る。ドキュメントの読み取りは webforai platform の内部向け RPC (Service Binding `WEBFORAI` → `PlatformRpc`、課金・API キーなし) で行う。`THEME_AGENT=off` でエージェントを止め、registry.json の検出だけにできる。

/// <reference types="vite/client" />

/** wrangler types は vars/bindings だけを出力するので、secrets (wrangler secret put / .dev.vars) をここで補う */
interface ExplorerSecrets {
  BETTER_AUTH_SECRET?: string
  /** 運営者の Better Auth ユーザー ID (カンマ区切り)。登録・再同期・再生成・プレビュー設定はこのユーザーだけ */
  ADMIN_USER_IDS?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GEMINI_API_KEY?: string
  /** 例: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/google-ai-studio */
  AI_GATEWAY_BASE_URL?: string
  AI_GATEWAY_TOKEN?: string
  /** Responses API (ドキュメントとプレビューのデモ生成) */
  OPENAI_API_KEY?: string
  /** Service Binding を使わず公開 URL で CF-Open-Agents-API を呼ぶ場合 (フォールバックの Coding Agent) */
  AGENTS_API_URL?: string
  AGENTS_API_TOKEN?: string
  /** "off" でテーマのエージェントを止める (registry.json の検出だけにする) */
  THEME_AGENT?: string
  /** フォールバックの Coding Agent の上限 (既定: レジストリあたり 30 回、月 $10) */
  AGENT_MAX_PER_REGISTRY?: string
  AGENT_MONTHLY_BUDGET_USD?: string
  /** 例: AI Gateway の https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai */
  OPENAI_BASE_URL?: string
  /** 単価の上書き (USD / 1M tokens)。未設定なら gpt-6-luna の公式価格 */
  DOC_MODEL_INPUT_USD_PER_MTOK?: string
  DOC_MODEL_CACHED_INPUT_USD_PER_MTOK?: string
  DOC_MODEL_OUTPUT_USD_PER_MTOK?: string
  PREVIEW_MODEL_INPUT_USD_PER_MTOK?: string
  PREVIEW_MODEL_CACHED_INPUT_USD_PER_MTOK?: string
  PREVIEW_MODEL_OUTPUT_USD_PER_MTOK?: string
  /** 取り込みのライフサイクル (v0.7)。再同期の間隔 (日、既定 7)・1 回の再同期の上限 (既定 60) */
  RESYNC_INTERVAL_DAYS?: string
  RESYNC_PER_RUN?: string
  /** 公式ディレクトリの自動取り込み: "on" | "off" (既定: cloudflare では on、local では off)。1 回の件数と、止める backlog */
  DIRECTORY_INTAKE?: string
  DIRECTORY_INTAKE_PER_RUN?: string
  DIRECTORY_INTAKE_MAX_BACKLOG?: string
  /** ステップごとのモデルの優先順 (カンマ区切り)。既定: doc=gpt-5.6-luna,gpt-6-luna / demo=OPENAI_MODEL / repair=gpt-6-luna,gpt-5.6-luna */
  OPENAI_DOC_MODELS?: string
  OPENAI_DEMO_MODELS?: string
  OPENAI_REPAIR_MODELS?: string
  /** OpenAI の無料枠: "off" で使わない。群の上限 (tokens/日) と、使う割合 (既定 0.9) */
  FREE_QUOTA?: string
  FREE_QUOTA_1M?: string
  FREE_QUOTA_10M?: string
  FREE_QUOTA_RATIO?: string
  /** レジストリ追加をメールでも受け付ける場合の宛先 (未設定なら GitHub Issues だけを案内する) */
  REGISTRY_REQUEST_EMAIL?: string
  /** 管理画面に申請 (GitHub Issues の registry-request) を出すための読み取りトークン (任意。無ければ匿名で 60 回/時) */
  GITHUB_TOKEN?: string
  /** スポンサー枠 (JSON: {"title","registry","href","image"?})。未設定なら出さない */
  SPONSOR_SLOT?: string
  /** "inline" でキュー・Workflow を使わずその場で回す。その同時実行数 */
  JOB_RUNNER?: string
  INLINE_CONCURRENCY?: string
  /** 無料枠を使い切った後: "pause" (既定。翌 UTC 日まで待つ) | "paid" (gpt-6-luna で有料で続ける) */
  LLM_OVERFLOW?: string
}

/** wrangler.jsonc でコメントアウトされている任意のバインディング (TEXT_SEARCH_BACKEND=ai-search のときだけ使う) */
interface ExplorerOptionalBindings {
  COMPONENT_SEARCH: AiSearchInstance
}

interface Env extends ExplorerSecrets, ExplorerOptionalBindings {}

declare namespace Cloudflare {
  /** wrangler.jsonc でコメントアウトされている任意のバインディング (TEXT_SEARCH_BACKEND=ai-search のときだけ使う) */
interface ExplorerOptionalBindings {
  COMPONENT_SEARCH: AiSearchInstance
}

interface Env extends ExplorerSecrets, ExplorerOptionalBindings {}
}

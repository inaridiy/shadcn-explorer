/// <reference types="vite/client" />

/** wrangler types は vars/bindings だけを出力するので、secrets (wrangler secret put / .dev.vars) をここで補う */
interface ExplorerSecrets {
  BETTER_AUTH_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GEMINI_API_KEY?: string
  /** 例: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/google-ai-studio */
  AI_GATEWAY_BASE_URL?: string
  AI_GATEWAY_TOKEN?: string
  /** Service Binding を使わず公開 URL で CF-Open-Agents-API を呼ぶ場合 */
  AGENTS_API_URL?: string
  AGENTS_API_TOKEN?: string
  /** Agents API 未設定時に Responses API を直接呼ぶ (ドキュメント生成のみ) */
  OPENAI_API_KEY?: string
  /** 例: AI Gateway の https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai */
  OPENAI_BASE_URL?: string
  /** 単価の上書き (USD / 1M tokens)。未設定なら gpt-6-luna の公式価格 */
  DOC_MODEL_INPUT_USD_PER_MTOK?: string
  DOC_MODEL_CACHED_INPUT_USD_PER_MTOK?: string
  DOC_MODEL_OUTPUT_USD_PER_MTOK?: string
  PREVIEW_MODEL_INPUT_USD_PER_MTOK?: string
  PREVIEW_MODEL_CACHED_INPUT_USD_PER_MTOK?: string
  PREVIEW_MODEL_OUTPUT_USD_PER_MTOK?: string
}

interface Env extends ExplorerSecrets {}

declare namespace Cloudflare {
  interface Env extends ExplorerSecrets {}
}

export interface Env {
  // Bindings declared in wrangler.toml.
  DIRECTORY: DurableObjectNamespace;
  USER: DurableObjectNamespace;

  // Vars.
  PAIR_TTL_MS?: string;
  APPROVAL_TTL_MS?: string;

  // Secrets — set via `wrangler secret put`.
  TELEGRAM_BOT_TOKEN: string;
  /** Optional bearer token gating /pair/bind. Leave unset to disable that route. */
  ADMIN_TOKEN?: string;
  /** Optional. Set during deployment and passed to setWebhook; verifies inbound TG webhook posts. */
  TG_WEBHOOK_SECRET?: string;
}

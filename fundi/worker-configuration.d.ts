// Bindings for the Fundi worker. Refresh with `wrangler types -c fundi/wrangler.jsonc`
// once bindings change. Inline `import()` types keep this a global script so
// `interface Env` stays global (no top-level import statements).

interface Env {
  // --- Cloudflare Agents (Durable Objects) ---
  // FundiMcp — the MCP surface (one instance per MCP session).
  MCP_OBJECT: DurableObjectNamespace;
  // FundiAgent — the durable per-task executor (one instance per taskId).
  FUNDI_AGENT: DurableObjectNamespace<import("./src/agent-do").FundiAgent>;

  // --- Task substrate ---
  // The task queue. Producer (submit) + consumer (this worker's queue handler).
  TASK_QUEUE: Queue<import("./src/types").SeedTask>;
  // D1 task ledger (status, dedup, audit, result summaries).
  DB: D1Database;
  // OSM-id dedupe cache / rate-limit windows.
  DEDUP_KV?: KVNamespace;

  // --- Workers AI (generate_description) ---
  // Inference binding; description generation routes through the AI Gateway.
  AI: Ai;

  // --- WorkOS AuthKit gate (same model as the mongodb-mcp worker) ---
  // KV used by workers-oauth-provider for codes/tokens and our OAuth state.
  OAUTH_KV: KVNamespace;
  // Public WorkOS client id (safe as a plain var).
  WORKOS_CLIENT_ID: string;
  // WorkOS API secret. `wrangler secret put WORKOS_CLIENT_SECRET`.
  WORKOS_CLIENT_SECRET: string;
  // High-entropy key signing the approved-clients cookie. `wrangler secret put`.
  COOKIE_ENCRYPTION_KEY: string;
  // Optional comma-separated WorkOS org ids allowed to authenticate.
  WORKOS_ALLOWED_ORG_IDS?: string;
  // Optional WorkOS permission required to use the MCP (e.g. "fundi:access").
  WORKOS_REQUIRED_PERMISSION?: string;

  // --- Secrets (set via `wrangler secret put`, never inlined) ---
  MONGODB_URI: string;
  WHAT3WORDS_API_KEY?: string;
  // Optional bearer token gating POST /tasks (server-to-server app surfaces).
  FUNDI_API_TOKEN?: string;

  // --- Vars ---
  // Workers AI model for generate_description (registry can override). Through an
  // AI Gateway the id is provider-prefixed, e.g. "workers-ai/@cf/moonshotai/kimi-k2.6".
  FUNDI_AI_MODEL?: string;
  // AI Gateway id descriptions route through (default "shamwari").
  FUNDI_AI_GATEWAY?: string;
  // Boundary guard bbox "s,w,n,e". Defaults to Africa; widen to lift to global.
  FUNDI_BOUNDARY_BBOX?: string;
  // Dev-only: allow the bundled African-capitals fallback when places.placesGeo
  // has no capital data. Never "true" in production.
  FUNDI_ALLOW_FALLBACK_CAPITALS?: string;
}

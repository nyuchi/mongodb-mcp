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
  // OSM-id dedupe / rate-limit cache.
  DEDUP_KV?: KVNamespace;

  // --- OAuth KV ---
  // Used by workers-oauth-provider for OAuth codes/tokens and by our handler for OAuth state.
  OAUTH_KV: KVNamespace;

  // --- Workers AI (generate_description) ---
  // Inference binding; description generation routes through the AI Gateway.
  AI: Ai;

  // --- WorkOS OAuth (Authorization Code + PKCE) for /mcp ---
  // Public client id for the WorkOS "connect" OAuth app; safe to commit.
  WORKOS_CLIENT_ID: string;
  // Org to pin the OAuth flow to, so the access token carries RBAC permissions.
  WORKOS_ORGANIZATION_ID?: string;
  // Random high-entropy string used to sign the approved-clients cookie.
  // Set with `wrangler secret put COOKIE_ENCRYPTION_KEY -c fundi/wrangler.jsonc`.
  COOKIE_ENCRYPTION_KEY: string;
  // Optional comma-separated WorkOS org ids allowed to use this MCP.
  WORKOS_ALLOWED_ORG_IDS?: string;
  // Optional WorkOS permission string required to use any tool.
  WORKOS_REQUIRED_PERMISSION?: string;

  // --- WorkOS M2M gate (client_credentials) for /tasks ---
  // AuthKit domain for the environment; the JWT issuer + JWKS base.
  WORKOS_AUTHKIT_DOMAIN?: string;
  // The fundi agents M2M application client id(s) — the expected `aud` on /tasks.
  // Falls back to WORKOS_M2M_CLIENT_ID if unset.
  WORKOS_AGENTS_M2M_CLIENT_ID?: string;
  // Fallback M2M client id if WORKOS_AGENTS_M2M_CLIENT_ID is not set.
  WORKOS_M2M_CLIENT_ID?: string;

  // --- Secrets (set via `wrangler secret put`, never inlined) ---
  MONGODB_URI: string;
  WHAT3WORDS_API_KEY?: string;
  // Optional static bearer accepted on POST /tasks (server-to-server surfaces).
  FUNDI_API_TOKEN?: string;

  // --- Vars ---
  FUNDI_AI_MODEL?: string;
  FUNDI_AI_GATEWAY?: string;
  FUNDI_BOUNDARY_BBOX?: string;
  FUNDI_ALLOW_FALLBACK_CAPITALS?: string;
}

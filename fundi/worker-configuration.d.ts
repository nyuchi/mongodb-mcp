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
  // Optional: OSM-id dedupe cache / rate-limit windows.
  DEDUP_KV?: KVNamespace;

  // --- Secrets (set via `wrangler secret put`, never inlined) ---
  MONGODB_URI: string;
  ANTHROPIC_API_KEY?: string;
  WHAT3WORDS_API_KEY?: string;
  // Optional bearer token gating POST /tasks. Open if unset.
  FUNDI_API_TOKEN?: string;

  // --- Vars ---
  // Anthropic model for generate_description (registry can override).
  FUNDI_ANTHROPIC_MODEL?: string;
  // Boundary guard bbox "s,w,n,e". Defaults to Africa; widen to lift to global.
  FUNDI_BOUNDARY_BBOX?: string;
  // Dev-only: allow the bundled African-capitals fallback when places.placesGeo
  // has no capital data. Never "true" in production.
  FUNDI_ALLOW_FALLBACK_CAPITALS?: string;
}

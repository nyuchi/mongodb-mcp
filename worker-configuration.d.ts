// Generated/maintained by hand. Run `npm run cf-typegen` to refresh from
// wrangler.jsonc once secrets/bindings are configured.

interface Env {
  // Durable Object binding for the MongoMcp agent (one instance per MCP session).
  MCP_OBJECT: DurableObjectNamespace;

  // KV used by workers-oauth-provider for codes/tokens and by our handler for OAuth state.
  OAUTH_KV: KVNamespace;

  // --- WorkOS AuthKit ---
  // Public client id, safe to ship as a plain var.
  WORKOS_CLIENT_ID: string;
  // WorkOS API secret. Set with `wrangler secret put WORKOS_CLIENT_SECRET`.
  WORKOS_CLIENT_SECRET: string;
  // Random high-entropy string used to sign the approved-clients cookie.
  // Set with `wrangler secret put COOKIE_ENCRYPTION_KEY`.
  COOKIE_ENCRYPTION_KEY: string;
  // Optional comma-separated list of WorkOS organization IDs allowed to use this MCP.
  // Leave empty to allow any authenticated user.
  WORKOS_ALLOWED_ORG_IDS?: string;
  // Optional WorkOS permission string required to use any tool (e.g. "mongodb:access").
  // Leave empty to grant access to all authenticated users.
  WORKOS_REQUIRED_PERMISSION?: string;

  // --- MongoDB ---
  // Shared MongoDB connection string. Set with `wrangler secret put MONGODB_URI`.
  MONGODB_URI: string;
}

// Generated/maintained by hand. Run `npm run cf-typegen` to refresh from
// wrangler.jsonc once secrets/bindings are configured.

interface Env {
  // Durable Object binding for the MongoMcp agent (one instance per MCP session).
  MCP_OBJECT: DurableObjectNamespace;

  // KV used by workers-oauth-provider for codes/tokens and by our handler for OAuth state.
  OAUTH_KV: KVNamespace;

  // --- WorkOS OAuth (Authorization Code + PKCE) ---
  // Public client id for the WorkOS "connect" OAuth app; safe to commit.
  WORKOS_CLIENT_ID: string;
  // WorkOS API secret. Set with `wrangler secret put WORKOS_API_KEY`.
  WORKOS_API_KEY: string;
  // Random high-entropy string used to sign the approved-clients cookie.
  // Set with `wrangler secret put COOKIE_ENCRYPTION_KEY`.
  COOKIE_ENCRYPTION_KEY: string;
  // Optional comma-separated WorkOS org ids allowed to use this MCP.
  WORKOS_ALLOWED_ORG_IDS?: string;
  // Optional WorkOS permission string required to use any tool (e.g. "mongodb:access").
  WORKOS_REQUIRED_PERMISSION?: string;

  // --- MongoDB ---
  // Shared MongoDB connection string. Set with `wrangler secret put MONGODB_URI`.
  MONGODB_URI: string;
}

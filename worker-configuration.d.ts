// Generated/maintained by hand. Run `npm run cf-typegen` to refresh from
// wrangler.jsonc once secrets/bindings are configured.

interface Env {
  // Durable Object binding for the MongoMcp agent (one instance per MCP session).
  MCP_OBJECT: DurableObjectNamespace;

  // --- WorkOS M2M gate (client_credentials) ---
  // AuthKit domain for the environment; the JWT issuer + JWKS base.
  // e.g. "https://your-env.authkit.app".
  WORKOS_AUTHKIT_DOMAIN?: string;
  // Our M2M application client id(s) — the expected JWT `aud` (comma-separated).
  WORKOS_M2M_CLIENT_ID?: string;
  // Optional comma-separated WorkOS org ids allowed (checked against `org_id`).
  WORKOS_ALLOWED_ORG_IDS?: string;

  // --- MongoDB ---
  // Shared MongoDB connection string. Set with `wrangler secret put MONGODB_URI`.
  MONGODB_URI: string;
}

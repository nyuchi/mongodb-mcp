// Generated/maintained by hand. Run `npm run cf-typegen` to refresh from
// wrangler.jsonc once secrets/bindings are configured.

interface Env {
  // KV used by workers-oauth-provider for codes/tokens and by our handler for OAuth state.
  OAUTH_KV: KVNamespace;

  // --- WorkOS OAuth (Authorization Code + PKCE) ---
  // Public client id for the WorkOS "connect" OAuth app; safe to commit.
  WORKOS_CLIENT_ID: string;
  // WorkOS AuthKit domain; used as the OAuth issuer and JWKS base. Set as a
  // secret from 1Password (nyuchi/workos), not a var — see docs/design/data-mcp.md.
  WORKOS_AUTHKIT_DOMAIN: string;
  // Org to pin the OAuth flow to, so the access token carries RBAC permissions.
  WORKOS_ORGANIZATION_ID?: string;
  // Random high-entropy string used to sign the approved-clients cookie.
  COOKIE_ENCRYPTION_KEY: string;
  // Comma-separated WorkOS org ids allowed to use this MCP. Unset fails closed.
  WORKOS_ALLOWED_ORG_IDS?: string;
  // Comma-separated permissions, any one of which admits a session
  // (the five `<store>:access` scopes). Unset fails closed.
  WORKOS_REQUIRED_PERMISSION?: string;

  // --- MongoDB Atlas (nyuchi-platform-doc-db) ---
  // Read-only user; every read tool uses it.
  MONGODB_RO_URI?: string;
  // Read-write user; only tools that need mongodb:write use it. Optional.
  MONGODB_RW_URI?: string;

  // --- Supabase (SUPABASE_<KEY>_RO_URL / _RW_URL, see src/stores/supabase.ts) ---
  SUPABASE_RELATIONAL_RO_URL?: string;
  SUPABASE_RELATIONAL_RW_URL?: string;
  SUPABASE_PAY_RO_URL?: string;
  SUPABASE_PAY_RW_URL?: string;
  SUPABASE_SHAMWARI_RO_URL?: string;
  SUPABASE_SHAMWARI_RW_URL?: string;
  SUPABASE_MZIZI_RO_URL?: string;
  SUPABASE_MZIZI_RW_URL?: string;

  // --- Private-network relay (relay/, Fly app nyuchi-data-relay) ---
  RELAY_URL?: string;
  // Shared HMAC key; the relay holds the same value.
  RELAY_SIGNING_SECRET?: string;
}

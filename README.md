# mongodb-mcp

Authenticated remote **Model Context Protocol** server for managing MongoDB,
running on Cloudflare Workers and served at **<https://mongodb.nyuchi.dev/mcp>**.
Identity is provided by **WorkOS AuthKit** through Cloudflare's
`workers-oauth-provider`, so the MCP endpoint is never public — every MCP
client (Claude Desktop, Cursor, etc.) goes through the WorkOS sign-in flow
before it can call any tool.

## Architecture

```text
MCP Client ──> Cloudflare Worker /mcp ──> WorkOS AuthKit (OAuth)
                       │
                       └── MongoMcp (Durable Object) ──> MongoDB cluster
```

- `OAuthProvider` (Cloudflare) implements the full OAuth 2.1 dance the MCP
  spec requires, including dynamic client registration.
- `AuthkitHandler` redirects the user to WorkOS, then captures `accessToken`,
  `refreshToken`, `user`, `organizationId`, and the JWT `permissions` claim as
  `props`. They are available inside every tool as `this.props`.
- `MongoMcp` is a `McpAgent` Durable Object. One DO per MCP session caches a
  single `MongoClient` so handshakes amortise across tool calls.
- All MongoDB operations are registered as MCP tools in `src/tools.ts`.

## Available tools

Discovery: `listDatabases`, `listCollections`, `dbStats`, `collStats`, `ping`.
Reads: `find`, `findOne`, `count`, `aggregate`.
Writes: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`,
`deleteMany` (refuses empty filter without `confirm: true`).
Admin: `createCollection`, `dropCollection` (requires `confirm: true`),
`renameCollection`, `createIndex`, `listIndexes`, `dropIndex`, `runCommand`.

All filter/document/pipeline arguments accept **Extended JSON** so you can pass
`{"_id": {"$oid": "..."}}` or `{"createdAt": {"$gte": {"$date": "2025-01-01"}}}`
directly.

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Provision a WorkOS AuthKit application

In the WorkOS dashboard:

1. Create an AuthKit-enabled application.
2. Add a redirect URI: `https://<your-worker-subdomain>.workers.dev/callback`
   (and `http://localhost:8788/callback` for local dev).
3. Copy the **Client ID** and **API Key** (client secret).

### 3. Create the KV namespace

```sh
npx wrangler kv namespace create OAUTH_KV
```

Paste the returned `id` into `wrangler.jsonc` under `kv_namespaces`.

### 4. Configure secrets

```sh
npx wrangler secret put WORKOS_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY    # e.g. openssl rand -hex 32
npx wrangler secret put MONGODB_URI
```

Set `WORKOS_CLIENT_ID` either in `wrangler.jsonc` under `vars` or as a secret.
Optionally restrict access:

- `WORKOS_ALLOWED_ORG_IDS` (comma-separated list of organization ids)
- `WORKOS_REQUIRED_PERMISSION` (e.g. `mongodb:access`, granted via WorkOS roles)

### 5. Run locally

Copy `.dev.vars.example` to `.dev.vars`, fill it in, then:

```sh
npm run dev
```

Open `http://localhost:8788/mcp` with an MCP client (see below). The first
request will redirect through WorkOS.

### 6. Deploy

```sh
npm run deploy
```

## Connecting an MCP client

For clients that don't support remote MCP over HTTP yet, use the `mcp-remote`
proxy:

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["mcp-remote", "https://mongodb.nyuchi.dev/mcp"]
    }
  }
}
```

The first connection opens a browser tab, you sign in via WorkOS, and the
access token is cached locally by `mcp-remote`.

## Tests

```sh
npm test          # vitest, runs inside workerd via @cloudflare/vitest-pool-workers
npm run type-check
```

Coverage:

- `test/oauth-utils.test.ts` — CSRF protection, state-binding cookies,
  approved-clients HMAC, URL/HTML sanitization, `OAuthError` serialisation.
- `test/authkit-handler.test.ts` — the Hono auth app: landing page,
  `/authorize` 400 without `client_id`, CSRF rejection, `/callback` without
  `state`, approval dialog rendering with mocked `OAUTH_PROVIDER`.
- `test/mongo.test.ts` — Extended JSON parse/stringify helpers (including
  truncation of oversized payloads).

End-to-end smoke testing against a real WorkOS tenant + MongoDB cluster is not
in the test suite; spin up `wrangler dev` with `.dev.vars` to exercise the
full path.

## MongoDB driver on Workers

The official `mongodb` Node driver runs on Workers thanks to the
`nodejs_compat` compatibility flag (which provides `node:net`, `node:tls`,
`node:dns`, and `node:timers`). The driver opens TCP sockets to your cluster
from inside the Durable Object's request handler — never at module scope —
which is the only place Workers permit TCP connections.

## Security notes

- The MCP endpoint is **not** public. `OAuthProvider` rejects unauthenticated
  requests to `/mcp` with `401 Unauthorized` and the auth-server metadata the
  spec requires.
- `deleteMany` with an empty filter and `dropCollection` both require an
  explicit confirmation flag from the tool caller.
- Cookies used during the OAuth dance are `__Host-` prefixed, `Secure`,
  `HttpOnly`, `SameSite=Lax`, and the approved-clients cookie is HMAC-signed
  with `COOKIE_ENCRYPTION_KEY`.
- WorkOS organization and permission gates are evaluated on every fresh login;
  refresh-token rotation is delegated to WorkOS.

## Releases

Tags are the source of truth. Every push to `main` runs
`.github/workflows/auto-tag.yml`, which inspects conventional-commit prefixes
since the last tag and pushes a new annotated tag:

| Commit prefix          | Bump  |
| ---------------------- | ----- |
| `feat:`                | minor |
| `fix:` / `perf:`       | patch |
| `chore:` / `docs:` / … | patch |
| `BREAKING CHANGE:`     | major |

The tag push fires `release.yml`, which delegates to the org-wide
`nyuchi/.github/.github/workflows/reusable-release.yml` — it validates the
semver shape, generates a CycloneDX SBOM, and publishes the GitHub release
with auto-generated notes.

A `RELEASE_BUMP_TOKEN` repo secret (fine-grained PAT with
`contents: write` and `actions: read`) is required so the auto-tag workflow
can push tags as a user identity rather than `GITHUB_TOKEN` —
without that, downstream tag-triggered workflows would not fire.

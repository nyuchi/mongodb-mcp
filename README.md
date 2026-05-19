# mongodb-mcp

Authenticated remote **Model Context Protocol** server for managing MongoDB,
running on Cloudflare Workers. The Nyuchi-hosted deployment lives at
**<https://mongodb.nyuchi.dev/mcp>** — sign in with WorkOS once and point any
MCP client at the URL. You can also stand the worker up under your own
Cloudflare account against your own MongoDB cluster; see _Set up your own
MCP server_ further down.

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
Reads: `find`, `findOne`, `count`, `aggregate`, `distinct`,
`estimatedDocumentCount`, `explain`.
Writes: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`,
`deleteMany` (refuses empty filter without `confirm: true`), `replaceOne`,
`findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete`, `bulkWrite`.
Admin: `createCollection`, `dropCollection` (requires `confirm: true`),
`renameCollection`, `createView`, `createIndex`, `listIndexes`, `dropIndex`,
`runCommand`.
Atlas Search: `listSearchIndexes`, `createSearchIndex`, `updateSearchIndex`,
`dropSearchIndex`.
User management: `createUser`, `updateUser`, `dropUser` (requires
`confirm: true`), `grantRolesToUser`, `revokeRolesFromUser`.

All filter/document/pipeline arguments accept **Extended JSON** so you can pass
`{"_id": {"$oid": "..."}}` or `{"createdAt": {"$gte": {"$date": "2025-01-01"}}}`
directly.

## How to use

If you just want to talk to the Nyuchi-hosted MCP, drop one of the snippets
below into your client of choice. Replace the URL with your own
`https://<your-worker>.workers.dev/mcp` if you self-host.

Clients with native remote-MCP support take the URL directly; older clients
use the [`mcp-remote`][mcp-remote] proxy, which spawns a local stdio bridge
and handles the OAuth dance for them. Either way the first connection opens a
browser tab for the WorkOS sign-in; the access token is then cached locally so
subsequent launches are silent.

[mcp-remote]: https://www.npmjs.com/package/mcp-remote

### Claude Desktop / Claude Code (CLI)

Claude Desktop: edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
Claude Code CLI: run `claude mcp add mongodb https://mongodb.nyuchi.dev/mcp --transport http`
(or add the snippet below to `~/.claude.json`).

```jsonc
{
  "mcpServers": {
    "mongodb": {
      "type": "http",
      "url": "https://mongodb.nyuchi.dev/mcp",
    },
  },
}
```

### Cursor

Add to `~/.cursor/mcp.json` (user-wide) or `.cursor/mcp.json` (project-local):

```jsonc
{
  "mcpServers": {
    "mongodb": {
      "url": "https://mongodb.nyuchi.dev/mcp",
    },
  },
}
```

### VS Code (GitHub Copilot Chat)

Native MCP since VS Code 1.99. Add to `.vscode/mcp.json` in the workspace or
the equivalent `mcp` block in user settings:

```jsonc
{
  "servers": {
    "mongodb": {
      "type": "http",
      "url": "https://mongodb.nyuchi.dev/mcp",
    },
  },
}
```

### Windsurf / Continue / Zed

These ship MCP support but do not yet speak remote HTTP — wrap with `mcp-remote`:

```jsonc
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mongodb.nyuchi.dev/mcp"],
    },
  },
}
```

Drop that into:

- **Windsurf** → `~/.codeium/windsurf/mcp_config.json`
- **Continue** → `~/.continue/config.json` under the top-level `mcpServers` key
- **Zed** → `~/.config/zed/settings.json` under `context_servers`

### Codex CLI (OpenAI)

`~/.codex/config.toml`:

```toml
[mcp_servers.mongodb]
command = "npx"
args = ["-y", "mcp-remote", "https://mongodb.nyuchi.dev/mcp"]
```

### Gemini CLI / Gemini Code Assist

`~/.gemini/settings.json` (or the workspace `.gemini/settings.json`):

```jsonc
{
  "mcpServers": {
    "mongodb": {
      "httpUrl": "https://mongodb.nyuchi.dev/mcp",
    },
  },
}
```

### Anything else

Any MCP client that can spawn a subprocess works via the proxy snippet shown
under "Windsurf / Continue / Zed". The browser-based OAuth flow is the same
across clients — sign in once with WorkOS, then `mcp-remote` (or the native
client) keeps the token fresh.

## Set up your own MCP server

You only need this section if you want to run your own instance — point it at
your own MongoDB cluster, customise org-/permission-gating, or host the
worker yourself. Most callers should be able to use the Nyuchi-hosted
deployment in the previous section.

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

### 5. MongoDB user role requirements

The user encoded in `MONGODB_URI` must have the privileges for whichever tools
you intend to call — the MCP can only do what that user is authorised to do.
Grant the smallest role that covers your usage:

| Tools you want to use                                                                                                                                                   | Required role (on the target db)                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `find`, `findOne`, `count`, `aggregate`, `distinct`, `listIndexes`, `collStats`                                                                                         | `read`                                                        |
| Above + `insert*`, `update*`, `delete*`, `replaceOne`, `findOneAnd*`, `bulkWrite`, `createIndex`, `dropIndex`, `createCollection`, `dropCollection`, `renameCollection` | `readWrite`                                                   |
| `createView`, `explain`, `dbStats`, profiler-style commands via `runCommand`                                                                                            | `dbAdmin` (combine with `readWrite`, or use `dbOwner`)        |
| `createUser`, `updateUser`, `dropUser`, `grantRolesToUser`, `revokeRolesFromUser`                                                                                       | `userAdmin`                                                   |
| Atlas Search tools (`listSearchIndexes`, `createSearchIndex`, …)                                                                                                        | Atlas-cluster role with Search privileges (e.g. `atlasAdmin`) |
| Anything on every database in the cluster                                                                                                                               | `readWriteAnyDatabase` / `dbAdminAnyDatabase` / `root`        |

Tools that hit a permission boundary return the MongoDB error plus a hint
pointing back to this section, so you can iterate without trial-and-error.
Grant or change roles in the Atlas UI (Database Access → edit user) or via
`mongosh`:

```js
db.getSiblingDB("admin").grantRolesToUser("<mcp-user>", [{ role: "readWrite", db: "<your-db>" }]);
```

### 6. Run locally

Copy `.dev.vars.example` to `.dev.vars`, fill it in, then:

```sh
npm run dev
```

Open `http://localhost:8788/mcp` with an MCP client (see _How to use_ above
and substitute the local URL). The first request will redirect through WorkOS.

### 7. Deploy

```sh
npm run deploy
```

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
- `test/tools.test.ts` — `permissionHint` / `fail` enrichment and the full
  registered-tool catalogue.

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
- CI runs CodeQL static analysis, `npm audit`, `actions/dependency-review-action`,
  and `gitleaks` on every PR — see `.github/workflows/security.yml`.

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

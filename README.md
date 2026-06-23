# mongodb-mcp

Authenticated remote **Model Context Protocol** server for managing MongoDB,
running on Cloudflare Workers. The Nyuchi-hosted deployment lives at
**<https://mongodb.nyuchi.dev/mcp>**. It is an internal, platform-team-only
service: callers authenticate with **WorkOS M2M (`client_credentials`)**. You
can also stand the worker up under your own Cloudflare account against your own
MongoDB cluster; see _Set up your own MCP server_ further down.

Every request to `/mcp` must carry a valid WorkOS M2M JWT, so the endpoint is
never public.

## Architecture

```text
MCP client ──Bearer JWT──> Cloudflare Worker /mcp ──verify (WorkOS JWKS)──> MongoMcp ──> MongoDB
   │                                                                          (Durable Object)
   └── obtains the JWT from WorkOS via client_credentials (client id + secret)
```

- A caller exchanges its WorkOS client id/secret for a short-lived JWT at
  `https://<authkit_domain>/oauth2/token`, then calls `/mcp` with
  `Authorization: Bearer <jwt>`.
- The worker `fetch` handler verifies that JWT **statelessly** against the
  environment JWKS (`src/m2m-auth.ts`): signature, `iss`, `aud`
  (`WORKOS_M2M_CLIENT_ID`), and an optional `org_id` allowlist. It fails closed.
- `MongoMcp` is a `McpAgent` Durable Object. One DO per MCP session caches a
  single `MongoClient` so handshakes amortise across tool calls.
- All MongoDB operations are registered as MCP tools in `src/tools.ts`.

> **Client note:** Claude's hosted connector speaks OAuth, not
> `client_credentials`. Consume this server from **Claude Code** (or a small
> proxy) that mints the M2M token and sets the `Authorization` header.

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

This is an internal service: every client must send a WorkOS **M2M** access
token as an `Authorization: Bearer <token>` header. Obtain the token from your
WorkOS client id/secret via `POST https://<authkit_domain>/oauth2/token`
(`grant_type=client_credentials`). Tokens are short-lived, so a small wrapper
that refreshes and injects the header is the usual setup. The browser OAuth
sign-in no longer applies. The snippets below show the URLs; add the
`Authorization` header (or `--header` flag) per your client.

### Claude Desktop / Claude Code (CLI)

Claude Desktop: edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
Claude Code CLI: run `claude mcp add mongodb https://mongodb.nyuchi.dev/mcp --transport http --header "Authorization: Bearer <m2m-token>"`
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
under "Windsurf / Continue / Zed". Whichever client you use, it must attach a
valid WorkOS M2M `Authorization: Bearer` token — typically via a small wrapper
that mints and refreshes the token from your client id/secret.

## Set up your own MCP server

You only need this section if you want to run your own instance — point it at
your own MongoDB cluster, customise org-/permission-gating, or host the
worker yourself. Most callers should be able to use the Nyuchi-hosted
deployment in the previous section.

### 1. Install dependencies

```sh
npm install
```

### 2. Provision a WorkOS M2M application

In the WorkOS dashboard:

1. Create an application of type **M2M** (machine-to-machine). Its client id is
   the JWT `aud` your worker expects.
2. Issue a **credential** (client id + secret) to each caller (e.g. your Claude
   Code setup). No redirect URI is needed for M2M.
3. Note your environment's **AuthKit domain** (e.g. `https://<env>.authkit.app`).

### 3. Configure the gate

Set these non-secret `vars` in `wrangler.jsonc`:

- `WORKOS_AUTHKIT_DOMAIN` — `https://<env>.authkit.app` (issuer + JWKS base)
- `WORKOS_M2M_CLIENT_ID` — the M2M application client id (expected `aud`)
- optionally `WORKOS_ALLOWED_ORG_IDS` — a comma-separated `org_id` allowlist

```sh
npx wrangler secret put MONGODB_URI
```

The worker holds **no** WorkOS secret — callers keep their own client id/secret
and exchange them for tokens themselves.

### 4. MongoDB user role requirements

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

### 5. Run locally

Copy `.dev.vars.example` to `.dev.vars`, fill it in, then:

```sh
npm run dev
```

Open `http://localhost:8788/mcp` with an MCP client (see _How to use_ above and
substitute the local URL), sending a valid `Authorization: Bearer` M2M token.

### 6. Deploy

```sh
npm run deploy
```

## Tests

```sh
npm test          # vitest, runs inside workerd via @cloudflare/vitest-pool-workers
npm run type-check
```

Coverage:

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

- The MCP endpoint is **not** public. The worker rejects any `/mcp` request
  without a valid WorkOS M2M JWT (`401`), and fails closed (`503`) when the gate
  is unconfigured.
- `deleteMany` with an empty filter and `dropCollection` both require an
  explicit confirmation flag from the tool caller.
- M2M access tokens are short-lived and verified statelessly against the WorkOS
  JWKS (`iss` / `aud`, optional `org_id`); the worker stores no WorkOS secret.
- CI runs `npm audit`, `actions/dependency-review-action`, and `gitleaks` on
  every PR — see `.github/workflows/security.yml`. CodeQL static analysis is
  handled by GitHub's Default Setup (Settings → Code security & analysis).

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

## License

[MIT](./LICENSE) © Nyuchi.

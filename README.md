# mongodb-mcp

Authenticated remote **Model Context Protocol** server for managing MongoDB,
running on Cloudflare Workers. The Nyuchi-hosted deployment lives at
**<https://mongodb.nyuchi.dev/mcp>**. It is an internal, platform-team-only
service: callers sign in with **WorkOS OAuth** (Authorization Code + PKCE) and
must hold the `mongodb:access` permission. You can also stand the worker up
under your own Cloudflare account against your own MongoDB cluster; see _Set up
your own MCP server_ further down.

Every request to `/mcp` rides on a WorkOS-issued OAuth session, so the endpoint
is never public.

## Architecture

```text
MCP client ──OAuth──> Cloudflare Worker ──> WorkOS AuthKit (sign in)
   │                       /authorize,/token,/callback        │
   │                                                          ▼
   └────────── authorized request ──> /mcp handler (stateless) ──> MongoDB
```

- `@cloudflare/workers-oauth-provider` fronts the worker, serving `/authorize`,
  `/token`, and `/register` and gating `/mcp`.
- On sign-in, `AuthkitHandler` (`src/authkit-handler.ts`) redirects the user to
  WorkOS, then on `/callback` exchanges the code (PKCE) and enforces the gate:
  the access token's `org_id` must be in `WORKOS_ALLOWED_ORG_IDS`, and the
  required permission (`mongodb:access`) must appear in the granted `scope`.
  The Connect app exposes permissions **as OAuth scopes**, so the worker
  requests the permission as a scope and WorkOS grants it only when the user's
  org role holds it.
- `/mcp` is **stateless**: `createMcpHandler` (from `agents/mcp/server`, on MCP
  SDK v2) builds a fresh `McpServer` for each request. There is no Durable
  Object and no server-side session, so any isolate can serve any request.
- The `MongoClient` is cached per **isolate** rather than per session, and the
  driver's own connection pool rides along with it. The client is created
  inside the request path — workerd will not open sockets at module scope — and
  discarded on a failed connect so one bad attempt cannot poison the isolate.
- All MongoDB operations are registered as MCP tools in `src/tools.ts`, each
  carrying a human-friendly `title` and behavioural annotations
  (`readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`) so
  clients can auto-approve safe reads and warn before destructive operations.

**No identity management.** This server exposes no tool that creates or
modifies MongoDB users or roles, and `runCommand` refuses those commands too.
See [Why there is no user or role management](#why-there-is-no-user-or-role-management).

> **Client note:** any MCP client that speaks remote OAuth (Claude's hosted
> connector, Claude Code, Cursor, VS Code, …) can connect directly — it runs
> the browser sign-in itself. Clients without native remote support use the
> `mcp-remote` proxy snippet below, which performs the OAuth dance for them.

## Available tools

Discovery: `listDatabases`, `listCollections`, `dbStats`, `collStats`, `ping`,
`serverStatus`, `hostInfo`, `buildInfo`, `connectionStatus`, `listCommands`.
Reads: `find`, `findOne`, `count`, `aggregate`, `distinct`,
`estimatedDocumentCount`, `explain`.
Writes: `insertOne`, `insertMany`, `updateOne`, `updateMany`, `deleteOne`,
`deleteMany` (refuses empty filter without `confirm: true`), `replaceOne`,
`findOneAndUpdate`, `findOneAndReplace`, `findOneAndDelete`, `bulkWrite`.
Admin: `createCollection`, `dropCollection` (requires `confirm: true`),
`dropDatabase` (requires `confirm: true`), `renameCollection`, `createView`,
`collMod`, `validate`, `convertToCapped` (requires `confirm: true`),
`dataSize`, `dbHash`, `runCommand`.
Indexes: `createIndex`, `createIndexes`, `listIndexes`, `dropIndex`,
`dropIndexes` (requires `confirm: true`), `hideIndex`, `unhideIndex`,
`indexStats`.
Monitoring: `currentOp`, `killOp`, `top`, `connPoolStats`, `getLog`,
`getProfilingStatus`, `setProfilingLevel`, `getProfilingData`.
Replication and sharding: `replSetGetStatus`, `listShards`, `balancerStatus`,
`enableSharding` (requires `confirm: true`), `shardCollection` (requires
`confirm: true`).
Atlas Search: `listSearchIndexes`, `createSearchIndex`, `updateSearchIndex`,
`dropSearchIndex`.

`connectionStatus` is the quickest way to see which user the server is
authenticated as and exactly which privileges it holds — start there when a
tool comes back with "not authorized". `hideIndex` lets you retire an index
safely: hide it, watch for regressions, then `dropIndex` once you are sure.

### Why there is no user or role management

Creating or altering MongoDB users and roles requires the `userAdmin`
privilege, and `userAdmin` **cannot be scoped down**. There is no form of it
that means "may manage only these users" or "may not grant more than it
holds": a credential that can create a user can create a `root` user, and a
credential that can grant roles can grant itself any role on the cluster. That
turns every other limit this server places on itself — the `confirm` gates, the
read-only annotations, the WorkOS permission check — into a speed bump, because
anyone who reaches the MCP could mint a fresh superuser and step around them.

So the tools are simply absent, and `runCommand` refuses the same commands
(`createUser`, `grantRolesToUser`, `createRole`, `rolesInfo`, and the rest of
the family, in any casing) rather than leaving a one-line bypass of their
removal. The `MONGODB_URI` credential should not hold `userAdmin` at all.

Manage users and roles where they can be audited and separately authorised: the
Atlas UI (Database Access), the Atlas Admin API, or `mongosh` with a
distinct admin credential that never reaches this worker.

All filter/document/pipeline arguments accept **Extended JSON** so you can pass
`{"_id": {"$oid": "..."}}` or `{"createdAt": {"$gte": {"$date": "2025-01-01"}}}`
directly.

## How to use

If you just want to talk to the Nyuchi-hosted MCP, drop one of the snippets
below into your client of choice. Replace the URL with your own
`https://<your-worker>.workers.dev/mcp` if you self-host.

This is an internal service. On first connect your client opens a WorkOS
**sign-in** page in the browser; authenticate with an account that belongs to
the allowed organization and holds the `mongodb:access` permission. The client
caches the resulting OAuth session and refreshes it automatically — there is no
token or header to manage by hand.

### Claude Desktop / Claude Code (CLI)

Claude Desktop: edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
Claude Code CLI: run `claude mcp add mongodb https://mongodb.nyuchi.dev/mcp --transport http`
(or add the snippet below to `~/.claude.json`). It will prompt you to sign in
through WorkOS on first use.

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

These ship MCP support but do not yet speak remote HTTP — wrap with `mcp-remote`,
which runs the OAuth sign-in for them:

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
under "Windsurf / Continue / Zed". `mcp-remote` handles the WorkOS OAuth
sign-in and token refresh on the client's behalf.

## Set up your own MCP server

You only need this section if you want to run your own instance — point it at
your own MongoDB cluster, customise org-/permission-gating, or host the
worker yourself. Most callers should be able to use the Nyuchi-hosted
deployment in the previous section.

### 1. Install dependencies

```sh
npm install
```

### 2. Provision a WorkOS Connect application

In the WorkOS dashboard:

1. Create a **Connect** (OAuth) application. Note its **client id**.
2. Add your worker's callback as a redirect URI:
   `https://<your-worker>/callback`.
3. Under **Authorization**, define a permission (e.g. `mongodb:access`) and
   attach it to the role(s) you want to grant. The Connect app surfaces
   permissions as OAuth scopes, so the worker can request the permission and
   WorkOS grants it only to users whose org role holds it.
4. Note your environment's **AuthKit/OAuth domain** (e.g.
   `https://<env>.authkit.app`) — it is both issuer and OAuth base.

### 3. Configure the gate

Set these non-secret `vars` in `wrangler.jsonc`:

- `WORKOS_AUTHKIT_DOMAIN` — `https://<env>.authkit.app` (issuer + OAuth base)
- `WORKOS_CLIENT_ID` — the Connect application client id
- `WORKOS_ORGANIZATION_ID` — the org the sign-in flow is pinned to
- `WORKOS_ALLOWED_ORG_IDS` — comma-separated `org_id` allowlist
- `WORKOS_REQUIRED_PERMISSION` — permission requested as a scope and enforced
  (e.g. `mongodb:access`)

Then set the secrets:

```sh
npx wrangler secret put MONGODB_URI
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any long random string
```

`COOKIE_ENCRYPTION_KEY` encrypts the client-approval cookie; the worker holds
no WorkOS secret (the Connect flow is a public PKCE client).

### 4. MongoDB user role requirements

The user encoded in `MONGODB_URI` must have the privileges for whichever tools
you intend to call — the MCP can only do what that user is authorised to do.
Grant the smallest role that covers your usage:

| Tools you want to use                                                                                                                                                                                                 | Required role (on the target db)                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `find`, `findOne`, `count`, `aggregate`, `distinct`, `listIndexes`, `collStats`, `dataSize`, `dbHash`                                                                                                                 | `read`                                                                |
| Above + `insert*`, `update*`, `delete*`, `replaceOne`, `findOneAnd*`, `bulkWrite`, `createIndex`, `createIndexes`, `dropIndex`, `createCollection`, `dropCollection`, `renameCollection`                              | `readWrite`                                                           |
| `createView`, `explain`, `dbStats`, `collMod`, `validate`, `convertToCapped`, `dropIndexes`, `hideIndex`, `unhideIndex`, `indexStats`, profiler tools (`getProfilingStatus`, `setProfilingLevel`, `getProfilingData`) | `dbAdmin` (combine with `readWrite`, or use `dbOwner`)                |
| `serverStatus`, `hostInfo`, `buildInfo`, `listCommands`, `getLog`, `top`, `connPoolStats`, `currentOp`, `replSetGetStatus`, `listShards`, `balancerStatus`                                                            | `clusterMonitor` (on `admin`, part of `clusterAdmin`)                 |
| `killOp`, `enableSharding`, `shardCollection`                                                                                                                                                                         | `clusterManager` / `hostManager` (on `admin`, part of `clusterAdmin`) |
| Atlas Search tools (`listSearchIndexes`, `createSearchIndex`, …)                                                                                                                                                      | Atlas-cluster role with Search privileges (e.g. `atlasAdmin`)         |
| Anything on every database in the cluster                                                                                                                                                                             | `readWriteAnyDatabase` / `dbAdminAnyDatabase` / `root`                |

**Never grant `userAdmin` (or `userAdminAnyDatabase`, or `root`) to this
credential.** No tool needs it, `runCommand` refuses the commands that would
use it, and it cannot be scoped — see
[Why there is no user or role management](#why-there-is-no-user-or-role-management).

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
substitute the local URL); the client runs the WorkOS sign-in on first connect.

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

- `test/mongo.test.ts` — Extended JSON parse/stringify helpers, including
  truncation of oversized payloads at the 256 KiB cap.
- `test/tools.test.ts` — `permissionHint` / `fail` enrichment, the full
  registered-tool catalogue and its exact size, the per-tool title and
  annotations, and the security invariants: no identity tool is registered,
  `runCommand` refuses identity commands, and every irreversible tool is gated
  behind `confirm: true`.
- `test/handler.test.ts` — drives the real stateless `/mcp` handler inside
  `workerd`: the `initialize` handshake, `tools/list` returning the expected
  catalogue with no identity tools, `runCommand` refusing `createUser`, and
  repeated requests each getting a fresh server instance.
- `test/oauth-utils.test.ts` — client-approval cookie signing and the approval
  dialog helpers.
- `test/access-gate.test.ts` — the org + permission gate: who is admitted, who
  is refused, and that missing configuration fails closed rather than open.

### Continuous integration

Every pull request and every push to `main` runs three workflows:

| Workflow       | Checks                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`       | `npm run type-check`, `npm test` (vitest in `workerd`), `wrangler deploy --dry-run` to catch bundle/config breakage |
| `lint.yml`     | org-wide reusable lint: `prettier --check`, `markdownlint`, `yamllint`, `actionlint`, JSON validity                 |
| `security.yml` | `npm audit --omit=dev --audit-level=high`, `dependency-review-action` (fails on high), `gitleaks` secret scan       |

`security.yml` also runs on a weekly cron so advisories published after a PR
merges still surface. CodeQL runs through GitHub's Default Setup rather than a
workflow in this repo — an advanced configuration here would conflict with it.

Fix lint locally with `npx prettier --write <files>` before pushing.

End-to-end smoke testing against a real WorkOS tenant + MongoDB cluster is not
in the test suite; spin up `wrangler dev` with `.dev.vars` to exercise the
full path.

## MongoDB driver on Workers

The official `mongodb` Node driver runs on Workers thanks to the
`nodejs_compat` compatibility flag (which provides `node:net`, `node:tls`,
`node:dns`, and `node:timers`). The driver opens TCP sockets to your cluster
from inside the request handler — never at module scope — which is the only
place Workers permit TCP connections. `getClient()` in `src/index.ts` enforces
that: the `MongoClient` promise is created lazily on the first request an
isolate serves, and cleared again if the connect fails.

Two dependency pins exist for the same runtime reason and are load-bearing:
`bson` is held at `7.2.0` because 7.3.0 generates random bytes in `ObjectId`'s
module-scope static initializer, which workerd rejects at startup validation;
and native optional dependencies (`snappy`, `kerberos`, `mongodb-client-encryption`,
`@mongodb-js/zstd`) are aliased to `src/native-stub.js` in `wrangler.jsonc`.

## Security notes

- The MCP endpoint is **not** public. `/mcp` is reachable only through a
  WorkOS-authorized OAuth session; unauthenticated requests never reach the
  tools, and the gate fails closed when unconfigured.
- Access is double-gated: the session's `org_id` must be in the allowlist **and**
  the `mongodb:access` permission must be present in the granted OAuth scope
  (WorkOS grants it only to users whose org role holds it). Both checks **fail
  closed** — if `WORKOS_ALLOWED_ORG_IDS` or `WORKOS_REQUIRED_PERMISSION` is
  unset, the worker refuses the request rather than treating absent config as
  "no restriction".
- Six irreversible tools refuse to run without `confirm: true` —
  `dropCollection`, `dropDatabase`, `dropIndexes`, `convertToCapped`,
  `enableSharding`, `shardCollection` — and `deleteMany` additionally refuses an
  empty (match-everything) filter unless confirmed. A test asserts the gate
  holds for every tool on that list.
- Tool responses are capped at 256 KiB by `stringifyEJson`, so a `find` over a
  large collection truncates rather than exhausting the isolate.
- The worker stores no WorkOS secret (public PKCE client);
  `COOKIE_ENCRYPTION_KEY` encrypts the client-approval cookie and `MONGODB_URI`
  is a Wrangler secret.
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

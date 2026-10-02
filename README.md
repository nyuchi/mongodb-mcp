# Nyuchi Data MCP

> One authenticated remote Model Context Protocol server for all of Nyuchi's
> data infrastructure — MongoDB Atlas, Supabase, Apache Doris, Cassandra and
> JanusGraph — on Cloudflare Workers, behind a WorkOS OAuth gate, with a small
> relay on Fly for the stores that live on Fly's private network.

[![CI](https://github.com/nyuchi/data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/nyuchi/data-mcp/actions/workflows/ci.yml)
[![Security](https://github.com/nyuchi/data-mcp/actions/workflows/security.yml/badge.svg)](https://github.com/nyuchi/data-mcp/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Fly.io](https://img.shields.io/badge/Fly.io-relay-8B5CF6?style=flat-square)
![Auth](https://img.shields.io/badge/Auth-WorkOS_OAuth_2.1-6363F1?style=flat-square)

**Endpoint:** `https://data.nyuchi.dev/mcp` (alias during the transition:
`https://data.nyuchi.dev/mcp`) | **Deploy:** Cloudflare Workers + Fly

This repository was `nyuchi/mongodb-mcp`. The design, the decision to rename
it, the relay, the credentials and the owner's switch-over steps are in
[`docs/design/data-mcp.md`](docs/design/data-mcp.md).

---

## Connect to it

```text
https://data.nyuchi.dev/mcp
```

**A bare request returns `401`, and that is correct.** Every call rides on a
WorkOS-issued OAuth session; the endpoint is never public. The `401` carries an
RFC 9728 challenge pointing a compliant client at the authorization server, so
it runs the sign-in itself:

```console
$ curl -s -D - -o /dev/null https://data.nyuchi.dev/mcp
HTTP/2 401
www-authenticate: Bearer realm="OAuth",
  resource_metadata="https://data.nyuchi.dev/.well-known/oauth-protected-resource/mcp"
```

A `404` or a DNS failure would mean the server is down. A `401` with that
header means it is up and gating correctly.

Access is **operator only** (the owner and Claude): the access token's
`org_id` must be in `WORKOS_ALLOWED_ORG_IDS`, and which tools a session sees
depends on the store permissions it holds — see [Permissions](#permissions).

## What it is

An internal Nyuchi operator tool. Applications reach data only through the
Nyuchi API; this server is how the owner, and Claude working with the owner,
inspect and operate the stores themselves, with least-privilege credentials
and every call audit-logged.

It is **read-only by default**. Each store has an access permission that opens
its read tools and a separate write permission that is needed, on top, for
anything that changes data. Credentials follow the same split: reads run as a
read-only database user, writes (where enabled at all) as a separate one.

## Architecture

```text
MCP client ──OAuth──> Cloudflare Worker (data.nyuchi.dev) ──> WorkOS AuthKit
                        │  one MCP server, tools per store, gated per store
                        ├──> MongoDB Atlas      (TLS, read-only user by default)
                        ├──> Supabase × 4       (Supavisor, read-only role by default)
                        └──> relay on Fly (HTTPS, HMAC-signed)
                               └── Fly 6PN ──> Doris (via Apache Doris MCP), Cassandra, JanusGraph
```

- `@cloudflare/workers-oauth-provider` fronts the worker, serving `/authorize`,
  `/token`, and `/register` and gating `/mcp`.
- On sign-in, `AuthkitHandler` (`src/authkit-handler.ts`) sends the user to
  WorkOS requesting every store permission as an OAuth scope; WorkOS grants
  only those the user's org role holds. On `/callback` the gate admits an
  allowed `org_id` holding at least one `<store>:access`. Both checks fail
  closed.
- `/mcp` is **stateless**: `createMcpHandler` (from `agents/mcp/server`, on MCP
  SDK v2) builds a fresh `McpServer` per request (`src/catalogue.ts`), and
  `ToolRegistry` (`src/registry.ts`) mounts only the tools that request's
  session may use, wrapping each with a call-time scope re-check and an audit
  line.
- MongoDB clients are cached per isolate (one per credential); Supabase uses
  `postgres` with one small pool per connection string.
- Doris, Cassandra and JanusGraph listen only on Fly's private network, which a
  Worker cannot reach. Their tools call the relay (`relay/`, Fly app
  `nyuchi-data-relay`), which verifies the Worker's signature, repeats the
  scope check, keeps writes off unless explicitly enabled, and talks to the
  stores over 6PN. Doris goes through **Apache Doris MCP 1.0**, run by the
  relay as a stdio child process.

> **Client note:** any MCP client that speaks remote OAuth (Claude's hosted
> connector, Claude Code, Cursor, VS Code, …) can connect directly — it runs
> the browser sign-in itself. Clients without native remote support use the
> `mcp-remote` proxy snippet below, which performs the OAuth dance for them.

## Permissions

| Store      | Read tools need    | Mutating tools also need |
| ---------- | ------------------ | ------------------------ |
| MongoDB    | `mongodb:access`   | `mongodb:write`          |
| Supabase   | `supabase:access`  | `supabase:write`         |
| Doris      | `doris:access`     | `doris:write`            |
| Cassandra  | `cassandra:access` | `cassandra:write`        |
| JanusGraph | `graph:access`     | `graph:write`            |

A tool is a "read tool" only if it declares `readOnlyHint: true`; everything
else needs the write permission too. `tools/list` shows only what the session
may call. Writes to the relay's stores additionally need the relay's
`RELAY_ALLOW_WRITES` switch for that store.

### Audit log

Every tool call logs one JSON line — user, email, organisation, tool, store,
read/write, outcome (`ok` / `error` / `denied`) and duration — to Workers Logs.
Arguments, query text and results are never logged.

## Available tools

Every tool name starts with its store.

### MongoDB (`mongodb_*`)

The full MongoDB tool set, each name prefixed with `mongodb_` (`find` is
`mongodb_find`). Read tools run as the read-only user (`MONGODB_RO_URI`);
everything else needs `mongodb:write` and runs as the read-write user
(`MONGODB_RW_URI`), which is optional — without it, write tools refuse.

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

### Supabase (`supabase_*`)

`supabase_listProjects`, `supabase_listTables`, `supabase_describeTable`,
`supabase_query` (one read-only statement, as the read-only role, inside a
`READ ONLY` transaction, row-capped); write: `supabase_execute` (needs
`supabase:write`, a configured `SUPABASE_<KEY>_RW_URL` and `confirm: true`).
Projects: `nyuchi_relational_db`, `nyuchi_pay_db`, `shamwari_ai_db`,
`mzizi_db`.

### Doris (`doris_*`, via Apache Doris MCP)

The eight domain tools of Apache Doris MCP 1.0: `doris_catalog`,
`doris_query`, `doris_cluster`, `doris_pipeline`, `doris_search`,
`doris_governance`, `doris_lakehouse`, `doris_semantic`. Call one with `{}` to
discover its children, then call it again with `child_tool`, `arguments` and
the `manifest_version` discovery returned. Doris MCP's catalogue is read-only.

### Cassandra (`cassandra_*`)

`cassandra_listKeyspaces`, `cassandra_listTables`, `cassandra_describeTable`,
`cassandra_select` (one `SELECT`, row-capped); write: `cassandra_execute`
(`INSERT` / `UPDATE` / `DELETE` / `BATCH` only — no schema changes).

### JanusGraph (`graph_*`)

`graph_summary`, `graph_findVertices`, `graph_neighbours` — built by the relay
from structured arguments with TinkerPop's `ReadOnlyStrategy` attached; write:
`graph_gremlin` (a raw Gremlin script, so it needs `graph:write`).

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
removal. Neither MongoDB credential (`MONGODB_RO_URI`, `MONGODB_RW_URI`)
should hold `userAdmin` at all.

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
the allowed organization and holds at least one store's `<store>:access`
permission. The client
caches the resulting OAuth session and refreshes it automatically — there is no
token or header to manage by hand.

### Claude Desktop / Claude Code (CLI)

Claude Desktop: edit `~/Library/Application Support/Claude/claude_desktop_config.json`
on macOS or `%APPDATA%\Claude\claude_desktop_config.json` on Windows.
Claude Code CLI: run `claude mcp add nyuchi-data https://data.nyuchi.dev/mcp --transport http`
(or add the snippet below to `~/.claude.json`). It will prompt you to sign in
through WorkOS on first use.

```jsonc
{
  "mcpServers": {
    "nyuchi-data": {
      "type": "http",
      "url": "https://data.nyuchi.dev/mcp",
    },
  },
}
```

### Cursor

Add to `~/.cursor/mcp.json` (user-wide) or `.cursor/mcp.json` (project-local):

```jsonc
{
  "mcpServers": {
    "nyuchi-data": {
      "url": "https://data.nyuchi.dev/mcp",
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
    "nyuchi-data": {
      "type": "http",
      "url": "https://data.nyuchi.dev/mcp",
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
    "nyuchi-data": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://data.nyuchi.dev/mcp"],
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
[mcp_servers.nyuchi-data]
command = "npx"
args = ["-y", "mcp-remote", "https://data.nyuchi.dev/mcp"]
```

### Gemini CLI / Gemini Code Assist

`~/.gemini/settings.json` (or the workspace `.gemini/settings.json`):

```jsonc
{
  "mcpServers": {
    "nyuchi-data": {
      "httpUrl": "https://data.nyuchi.dev/mcp",
    },
  },
}
```

### Anything else

Any MCP client that can spawn a subprocess works via the proxy snippet shown
under "Windsurf / Continue / Zed". `mcp-remote` handles the WorkOS OAuth
sign-in and token refresh on the client's behalf.

## Set up your own MCP server

You only need this section to run another instance. The Nyuchi deployment's
own switch-over (WorkOS permissions, credentials, 1Password fields, the Fly
relay, DNS) is in [`docs/design/data-mcp.md`](docs/design/data-mcp.md),
section 8.

### 1. Install dependencies

```sh
npm install
```

### 2. Provision a WorkOS Connect application

In the WorkOS dashboard:

1. Create a **Connect** (OAuth) application. Note its **client id**.
2. Add your worker's callback as a redirect URI:
   `https://<your-worker>/callback`.
3. Under **Authorization**, define the ten permissions in
   [Permissions](#permissions) and attach them to the role(s) you want to
   grant. The Connect app surfaces permissions as OAuth scopes, so the worker
   requests all ten and WorkOS grants only those the user's org role holds.
4. Note your environment's **AuthKit/OAuth domain** (e.g.
   `https://<env>.authkit.app`) — it is both issuer and OAuth base.

### 3. Configure the gate

Non-secret `vars` in `wrangler.jsonc`:

- `WORKOS_CLIENT_ID` — the Connect application client id
- `WORKOS_ORGANIZATION_ID` — the org the sign-in flow is pinned to
- `WORKOS_ALLOWED_ORG_IDS` — comma-separated `org_id` allowlist
- `WORKOS_REQUIRED_PERMISSION` — comma-separated, any-of: the permissions that
  get a session through the front door (the five `<store>:access`)
- `RELAY_URL` — the relay's base URL

Secrets (`wrangler secret put <NAME>`; Nyuchi pushes them from 1Password):

| Secret                  | Purpose                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| `WORKOS_AUTHKIT_DOMAIN` | AuthKit/OAuth domain (issuer + OAuth base)                            |
| `COOKIE_ENCRYPTION_KEY` | encrypts the client-approval cookie (`openssl rand -hex 32`)          |
| `MONGODB_RO_URI`        | read-only MongoDB user; every MongoDB read tool                       |
| `MONGODB_RW_URI`        | optional read-write user; MongoDB write tools                         |
| `SUPABASE_<KEY>_RO_URL` | read-only role per project (`RELATIONAL`, `PAY`, `SHAMWARI`, `MZIZI`) |
| `SUPABASE_<KEY>_RW_URL` | optional read-write role per project                                  |
| `RELAY_SIGNING_SECRET`  | HMAC key shared with the relay (`openssl rand -hex 32`)               |

The worker holds no WorkOS secret (the Connect flow is a public PKCE client).
A store whose secret is missing keeps its tools listed; they answer with the
name of the missing secret.

### 4. MongoDB user role requirements

The read-only user (`MONGODB_RO_URI`) needs `readAnyDatabase` and
`clusterMonitor` on `admin`, which covers every read tool. The read-write user
(`MONGODB_RW_URI`), if you create one, needs the roles for the write tools you
intend to use. (Permission hints in tool errors still say `MONGODB_URI`; read
that as whichever of the two the tool ran with.) The table maps tools to
roles:

| Tools you want to use                                                                                                                                                                                                 | Required role (on the target db)                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `find`, `findOne`, `count`, `aggregate`, `distinct`, `listIndexes`, `collStats`, `dataSize`, `dbHash`                                                                                                                 | `read`                                                                |
| Above + `insert*`, `update*`, `delete*`, `replaceOne`, `findOneAnd*`, `bulkWrite`, `createIndex`, `createIndexes`, `dropIndex`, `createCollection`, `dropCollection`, `renameCollection`                              | `readWrite`                                                           |
| `createView`, `explain`, `dbStats`, `collMod`, `validate`, `convertToCapped`, `dropIndexes`, `hideIndex`, `unhideIndex`, `indexStats`, profiler tools (`getProfilingStatus`, `setProfilingLevel`, `getProfilingData`) | `dbAdmin` (combine with `readWrite`, or use `dbOwner`)                |
| `serverStatus`, `hostInfo`, `buildInfo`, `listCommands`, `getLog`, `top`, `connPoolStats`, `currentOp`, `replSetGetStatus`, `listShards`, `balancerStatus`                                                            | `clusterMonitor` (on `admin`, part of `clusterAdmin`)                 |
| `killOp`, `enableSharding`, `shardCollection`                                                                                                                                                                         | `clusterManager` / `hostManager` (on `admin`, part of `clusterAdmin`) |
| Atlas Search tools (`listSearchIndexes`, `createSearchIndex`, …)                                                                                                                                                      | Atlas-cluster role with Search privileges (e.g. `atlasAdmin`)         |
| Anything on every database in the cluster                                                                                                                                                                             | `readWriteAnyDatabase` / `dbAdminAnyDatabase` / `root`                |

**Never grant `userAdmin` (or `userAdminAnyDatabase`, or `root`) to either
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
cd relay && npm test && npm run type-check   # the relay: node:test on Node 24
```

Coverage:

- `test/registry.test.ts` — the scope gating and the tool registry: exact
  per-store catalogues, the store prefix, access derived from `readOnlyHint`
  (a missing hint counts as a write), every destructive tool behind write, a
  session with no scopes seeing nothing, one store's access showing only that
  store's read tools, the call-time re-check, and audit lines that carry no
  arguments or results.
- `test/relay.test.ts` — request signing (tampered body, path, method, secret,
  stale timestamp, missing headers) and the Worker's relay client.
- `relay/test/*.test.ts` — the relay: its op table pinned against the Worker's
  tool lists, scope and write-switch enforcement, CQL guards, nonce replay,
  the signed HTTP handler, and the stdio MCP client against a stand-in Doris
  MCP.

- `test/mongo.test.ts` — Extended JSON parse/stringify helpers, including
  truncation of oversized payloads at the 256 KiB cap.
- `test/tools.test.ts` — `permissionHint` / `fail` enrichment, the full
  registered-tool catalogue and its exact size, the per-tool title and
  annotations, and the security invariants: no identity tool is registered,
  `runCommand` refuses identity commands, and every irreversible tool is gated
  behind `confirm: true`.
- `test/handler.test.ts` — drives the real stateless `/mcp` handler inside
  `workerd`: the `initialize` handshake, `tools/list` returning the expected
  catalogue with no identity tools, `runCommand` refusing `createUser`,
  repeated requests each getting a fresh server instance, and the production
  catalogue's `tools/list` following the session's scopes.
- `test/oauth-utils.test.ts` — client-approval cookie signing and the approval
  dialog helpers.
- `test/access-gate.test.ts` — the org + permission gate: who is admitted, who
  is refused, and that missing configuration fails closed rather than open.

### Continuous integration

Every pull request and every push to `main` runs three workflows:

| Workflow       | Checks                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`       | `npm run type-check`, `npm test` (vitest in `workerd`), `wrangler deploy --dry-run` to catch bundle/config breakage; the relay's type-check and tests |
| `lint.yml`     | org-wide reusable lint: `prettier --check`, `markdownlint`, `yamllint`, `actionlint`, JSON validity                                                   |
| `security.yml` | `npm audit --omit=dev --audit-level=high`, `dependency-review-action` (fails on high), `gitleaks` secret scan                                         |

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
place Workers permit TCP connections. `mongoClient()` in `src/index.ts`
enforces that: each credential's `MongoClient` promise is created lazily on the
first request an isolate serves, and dropped again if the connect fails. The
Supabase driver (`postgres`) follows the same rule and is imported dynamically,
so the test loader never pulls it in.

Two dependency pins exist for the same runtime reason and are load-bearing:
`bson` is held at `7.2.0` because 7.3.0 generates random bytes in `ObjectId`'s
module-scope static initializer, which workerd rejects at startup validation;
and native optional dependencies (`snappy`, `kerberos`, `mongodb-client-encryption`,
`@mongodb-js/zstd`) are aliased to `src/native-stub.js` in `wrangler.jsonc`.

## Security notes

- The MCP endpoint is **not** public. `/mcp` is reachable only through a
  WorkOS-authorized OAuth session; unauthenticated requests never reach the
  tools, and the gate fails closed when unconfigured.
- Access is gated twice: the session's `org_id` must be in the allowlist **and**
  it must hold at least one `<store>:access` (WorkOS grants a permission only
  to users whose org role holds it). Both checks **fail closed** — if
  `WORKOS_ALLOWED_ORG_IDS` or `WORKOS_REQUIRED_PERMISSION` is unset, the worker
  refuses the request rather than treating absent config as "no restriction".
  Past the door, each store's tools need that store's permission, and anything
  that changes data needs `<store>:write` as well.
- The relay accepts only HMAC-signed requests (timestamp window, single-use
  nonce, body hash), repeats the scope check, and refuses writes to any store
  not named in `RELAY_ALLOW_WRITES`. Doris MCP runs as its stdio child and
  opens no port.
- Six irreversible tools refuse to run without `confirm: true` —
  `dropCollection`, `dropDatabase`, `dropIndexes`, `convertToCapped`,
  `enableSharding`, `shardCollection` — and `deleteMany` additionally refuses an
  empty (match-everything) filter unless confirmed. A test asserts the gate
  holds for every tool on that list.
- Tool responses are capped at 256 KiB by `stringifyEJson`, so a `find` over a
  large collection truncates rather than exhausting the isolate.
- The worker stores no WorkOS secret (public PKCE client);
  `COOKIE_ENCRYPTION_KEY` encrypts the client-approval cookie; store
  credentials are Wrangler secrets (Worker) and Fly secrets (relay), pushed
  from 1Password.
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

## Licence

Licensed under the [MIT Licence](./LICENSE).

© Nyuchi Africa (PVT) Ltd.

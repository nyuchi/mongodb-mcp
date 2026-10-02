# Nyuchi data MCP — design

Status: **scaffold, not deployed**. This branch adds the code and the
configuration; nothing has been changed in Cloudflare, Fly, WorkOS, Atlas or
Supabase. The owner steps at the end turn it on.

Owner decisions this design implements (2026-10-02):

- one MCP repository, one MCP, connecting to **all** Nyuchi data
  infrastructure;
- every Nyuchi MCP runs on `nyuchi.dev`;
- the data MCP is an **internal operator tool** (owner + Claude). It may reach
  stores directly, with least-privilege, read-only-by-default credentials gated
  by WorkOS permissions. Apps keep using only the Nyuchi API;
- Doris is reached through **Apache's official Doris MCP server**, not a
  reimplementation.

## 1. One repository: rename `nyuchi/mongodb-mcp` to `nyuchi/data-mcp`

The two options were (A) a new repository `nyuchi/data-mcp` that absorbs
mongodb-mcp, or (B) evolving `nyuchi/mongodb-mcp` in place and renaming it
later.

**Choice: A, delivered as a rename of the existing repository, done now.** The
code on this branch evolves mongodb-mcp in place; the owner renames the
repository before (or right after) merging:

```sh
gh repo rename data-mcp -R nyuchi/mongodb-mcp
```

Why a rename rather than a new repository:

- **History, issues, pull requests, releases and tags stay.** The auto-tag
  release line continues from the current tag instead of restarting.
- **Settings stay**: the `RELEASE_BUMP_TOKEN` Actions secret, the org lint
  ruleset, Dependabot, CodeQL default setup, CODEOWNERS. A new repository would
  need each of them recreated, and a missed one fails silently (a ruleset that
  is not applied blocks nothing).
- **GitHub redirects** the old URL, web links and `git remote` URLs to the new
  name, so existing clones and links keep working.
- Importing history into a fresh repository (subtree or filter-repo) gives the
  same commits but a second copy of the project's past, with PR numbers that
  point at a repository nobody looks at any more.

Why now rather than later (B): the name is part of the contract. The 1Password
item is titled `<org>/<repo>`, `owner-actions.sh` steps refer to it, and the
Worker's public page links to it. Created under `nyuchi/mongodb-mcp`, every one
of those would have to be moved a second time. Renaming first means the new
secrets are created once, as `nyuchi/data-mcp`.

After the rename, move the local clone the same way `owner-actions.sh` does for
other repositories (`move_clone`): `~/GitHub/nyuchi/mongodb-mcp` to
`~/GitHub/nyuchi/data-mcp`, with the remote set to
`https://github.com/nyuchi/data-mcp.git`. The Cloudflare Worker keeps its
current name (`mongodb-mcp`) through the transition; see section 8.

## 2. Architecture

```text
                       WorkOS AuthKit (sign-in, permissions as OAuth scopes)
                                ▲
MCP client ──OAuth──> Cloudflare Worker  https://data.nyuchi.dev/mcp
                      (alias: mongodb.nyuchi.dev during the transition)
                       │  one MCP server, tools grouped per store,
                       │  each group gated by its own WorkOS permission,
                       │  every call audit-logged
                       │
                       ├── TLS ─────────────> MongoDB Atlas  nyuchi-platform-doc-db (af-south-1)
                       ├── TLS (Supavisor) ─> Supabase  nyuchi_relational_db, nyuchi_pay_db,
                       │                                shamwari_ai_db, mzizi_db
                       │
                       └── HTTPS, HMAC-signed ──> relay  nyuchi-data-relay.fly.dev (Fly, jnb)
                                                    │  Fly 6PN (private)
                                                    ├── stdio ─> Apache Doris MCP 1.0 ─> mukoko-doris:9030/8030
                                                    ├── CQL ──────────────────────────> nyuchi-cassandra:9042
                                                    └── Gremlin (WebSocket) ──────────> nyuchi-janusgraph:8182
```

MongoDB and Supabase are reachable from Cloudflare, so the Worker talks to them
itself. Doris, Cassandra and JanusGraph listen only on Fly's private network,
which a Worker cannot reach; for those the Worker calls a small relay on Fly
that can. CouchDB is stopped and has no tools.

## 3. The front door (Cloudflare Worker)

The existing OAuth flow is unchanged in shape: `@cloudflare/workers-oauth-provider`
serves `/authorize`, `/token` and `/register`; `src/authkit-handler.ts` runs the
WorkOS Authorization Code + PKCE dance; the Connect application exposes
permissions as OAuth scopes. What changes is which scopes are asked for and how
they are used.

### Permissions

Ten WorkOS permissions, two per store:

| Store      | Read tools need    | Mutating tools also need |
| ---------- | ------------------ | ------------------------ |
| MongoDB    | `mongodb:access`   | `mongodb:write`          |
| Supabase   | `supabase:access`  | `supabase:write`         |
| Doris      | `doris:access`     | `doris:write`            |
| Cassandra  | `cassandra:access` | `cassandra:write`        |
| JanusGraph | `graph:access`     | `graph:write`            |

- At sign-in the Worker requests all ten (`ALL_STORE_SCOPES` in
  `src/scopes.ts`). WorkOS grants only those the user's organisation role
  holds, so one sign-in picks up whatever subset the owner has given that role.
- The front door (`checkAccess`) admits a session from an allowed organisation
  that holds **any one** `<store>:access`. `WORKOS_REQUIRED_PERMISSION` is now a
  comma-separated any-of list. Both checks still fail closed when unset.
- The server built for a request registers **only the tools that session may
  use** (`ToolRegistry.mount` in `src/registry.ts`), so `tools/list` itself
  reflects the permissions. Each handler re-checks at call time.
- **Read-only by default.** A tool needs `<store>:write` (on top of access)
  unless it declares `readOnlyHint: true`. The rule is derived from the tool's
  own annotations, not a second list, so a tool that forgets the hint is
  over-protected rather than exposed. `<store>:write` without `<store>:access`
  grants nothing.
- Exact matching only: `doris:access:admin` or `xdoris:access` grant nothing.

### Tools

Tools are namespaced by store so five stores can each have a `query`:

| Store     | Tools                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB   | the existing 64 tools, prefixed: `mongodb_find`, `mongodb_insertOne`, … (read ones need access only)                                                                  |
| Supabase  | `supabase_listProjects`, `supabase_listTables`, `supabase_describeTable`, `supabase_query`; write: `supabase_execute`                                                 |
| Doris     | Doris MCP's eight domains: `doris_catalog`, `doris_query`, `doris_cluster`, `doris_pipeline`, `doris_search`, `doris_governance`, `doris_lakehouse`, `doris_semantic` |
| Cassandra | `cassandra_listKeyspaces`, `cassandra_listTables`, `cassandra_describeTable`, `cassandra_select`; write: `cassandra_execute`                                          |
| Graph     | `graph_summary`, `graph_findVertices`, `graph_neighbours`; write: `graph_gremlin`                                                                                     |

Renaming the MongoDB tools (`find` becomes `mongodb_find`) is a breaking change
for anyone with the old names saved in a prompt; clients re-read `tools/list`
on connect, so nothing else breaks.

MongoDB's catalogue is registered **twice**: once over the read-only user
(`MONGODB_RO_URI`), keeping only the read-only tools, and once over the
read-write user (`MONGODB_RW_URI`), keeping only the rest. No read ever runs on
a credential that can write, and without `MONGODB_RW_URI` the write tools say
so and do nothing. Supabase does the same with `SUPABASE_<KEY>_RO_URL` and
`SUPABASE_<KEY>_RW_URL`; reads also run inside a `READ ONLY` transaction over
the extended protocol, which accepts a single statement, so
`COMMIT; DELETE …` cannot step out of it.

### Audit log

Every tool call writes one JSON line through `consoleAuditSink`
(`src/audit.ts`), persisted by Workers Logs (`observability.logs` is on in
`wrangler.jsonc`):

```json
{
  "event": "tool_call",
  "at": "2026-10-02T12:00:00.000Z",
  "user": "user_01…",
  "email": "owner@…",
  "organizationId": "org_01…",
  "tool": "supabase_query",
  "store": "supabase",
  "access": "read",
  "outcome": "ok",
  "durationMs": 41
}
```

`outcome` is `ok`, `error` or `denied`. Arguments, query text and results are
**never** logged: they can carry personal data. A test asserts the exact key
set and that a query's text, parameters and rows do not appear in the line.
The relay writes its own line per call (`relay_call`) with the same fields,
so a call that fails on the Fly side is visible there too. If Workers Logs
retention is too short, add a Logpush job or an Analytics Engine dataset as the
sink; the `AuditSink` type is the seam.

## 4. The private-network relay (Fly)

### Shape: one authenticated public HTTPS endpoint

Options considered:

| Option                                                          | For                                                                                           | Against                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public HTTPS on Fly, HMAC-signed requests** (chosen)          | One process, one app; plain `fetch` + WebCrypto in the Worker; nothing else to run or pay for | The hostname is public; everything rests on the signature check                                                                                |
| Flycast + `cloudflared` tunnel, Cloudflare Access service token | No public Fly IP                                                                              | A second process to run and monitor; the Access service token is still a bearer secret; two products to configure                              |
| mTLS                                                            | Strong client identity                                                                        | Fly's proxy terminates TLS and does not verify client certificates, so it would need TLS passthrough and certificate handling inside the relay |

Chosen: **public HTTPS on Fly with HMAC-signed requests.** The tunnel's main
benefit — no public address — does not buy much here, because the Access
service token it would rely on is itself a shared secret sent with every
request, just as the signing key is. A signature is stronger than a bearer
token: the secret never travels, and each request is bound to its own body,
path and time. Workers VPC (binding a Worker to a private service over a
tunnel) is the upgrade path if Cloudflare's offering is suitable later; it
would remove the public endpoint without changing the relay's contract.

### The contract

`POST https://nyuchi-data-relay.fly.dev/v1/call`, JSON body:

```json
{
  "store": "cassandra",
  "op": "select",
  "args": { "cql": "SELECT …", "params": [], "limit": 100 },
  "caller": { "id": "user_01…", "email": "owner@…", "scopes": ["cassandra:access"] }
}
```

Headers `x-nyuchi-relay-timestamp`, `x-nyuchi-relay-nonce` and
`x-nyuchi-relay-signature`, where the signature is
`base64url(HMAC-SHA256(RELAY_SIGNING_SECRET, METHOD \n PATH \n timestamp \n nonce \n sha256(body)))`.
`src/relay-signing.ts` is the one implementation, imported by both the Worker
and the relay (it uses only WebCrypto, so it runs unchanged in workerd and in
Node 24).

The relay (`relay/src/server.ts`) refuses with `401` unless the signature
verifies, the timestamp is within ±60 s, and the nonce has not been seen in
the window; then it applies its own checks before touching a store:

1. the op must be in its table (`relay/src/ops.ts`); anything else is `404`;
2. the signed `caller.scopes` must include `<store>:access` (and
   `<store>:write` for a write) — the same rule as the Worker, repeated so a
   Worker bug cannot widen access;
3. writes are **off for every store** unless the relay's `RELAY_ALLOW_WRITES`
   names it (e.g. `cassandra`). Turning writes on is a deliberate change on the
   Fly app, separate from granting the permission in WorkOS;
4. bodies over 256 KiB are refused; `/healthz` is the only unauthenticated
   path.

What a leaked `RELAY_SIGNING_SECRET` would allow: calling the relay's ops with
any claimed scopes, so every read op, and write ops only for stores listed in
`RELAY_ALLOW_WRITES`. Rotate it by generating a new value in 1Password and
pushing it to both the Worker and the relay.

The nonce cache is in memory, so the relay runs as **one machine**
(`fly.toml`). Scaling out would let a captured request be replayed once
against a second machine within the 60-second window; if that is ever needed,
move the nonce cache to a shared store first.

### Code and deployment

The relay lives in this repository under `relay/`, as its own Node 24 package
(Node runs its TypeScript directly; there is no build step). CI type-checks
and tests it in a separate job; Dependabot watches `relay/` for npm and Docker.

| Path                     | Purpose                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `relay/src/server.ts`    | HTTP server: signature, nonce, scope and write checks; audit line                 |
| `relay/src/ops.ts`       | The op table and its guards                                                       |
| `relay/src/doris.ts`     | Runs Apache Doris MCP as a stdio child and speaks MCP to it                       |
| `relay/src/cassandra.ts` | `cassandra-driver`, one client per role                                           |
| `relay/src/graph.ts`     | `gremlin` (3.7, matching JanusGraph 1.1), read traversals with `ReadOnlyStrategy` |
| `relay/Dockerfile`       | Node 24 + `uv`-installed `doris-mcp-server==1.0.0` (Python 3.12)                  |
| `relay/fly.toml`         | App `nyuchi-data-relay`, region `jnb`, one shared-cpu-1x 1 GB machine, auto-stop  |

The image needs `src/relay-signing.ts`, so it builds from the repository root:

```sh
fly deploy . --config relay/fly.toml --dockerfile relay/Dockerfile
```

## 5. Doris: Apache's Doris MCP server

Verified against the official sources on 2026-10-02:

| Item          | Value                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository    | <https://github.com/apache/doris-mcp-server> (Apache-2.0)                                                                                               |
| Release       | `1.0.0`, published 2026-08-01 (GitHub release and tag `1.0.0`)                                                                                          |
| Package       | PyPI `doris-mcp-server==1.0.0`, Python `>=3.12`; commands `doris-mcp-server`, `doris-mcp-client`                                                        |
| Transports    | **stdio** and **Streamable HTTP** (`POST /mcp`, liveness `GET /live`, Doris-backed readiness `GET /ready`)                                              |
| Protocol      | MCP `2026-07-28` preferred (stateless, no `initialize`); `2025-11-25` only through the opt-in `/mcp/legacy` HTTP adapter; older revisions not supported |
| Auth (HTTP)   | static bearer tokens (`ENABLE_TOKEN_AUTH`, `TOKEN_<ID>`), JWT, external OAuth/OIDC, Doris-backed OAuth; non-loopback HTTP refuses to start without auth |
| Tool surface  | default `hierarchical` mode: 8 domains, 55 children, discovered by calling a domain with `{}`; `MCP_TOOL_EXPOSURE_MODE=flat` exposes the 55 directly    |
| Safety        | built-in 1.0 catalogue is **read-only** (`doris_admin` reserved, not registered); SQL guard, bounded rows/bytes/time; Doris RBAC is the final authority |
| Configuration | `DORIS_HOST`, `DORIS_PORT` (9030), `DORIS_USER`, `DORIS_PASSWORD`, `DORIS_DATABASE`, `DORIS_FE_HTTP_PORT` (8030), …                                     |

How it is run: the relay starts `doris-mcp-server --transport stdio` as a child
process and sends it self-contained `2026-07-28` JSON-RPC requests (the
protocol version in `params._meta`). stdio rather than its HTTP transport
because then Doris MCP opens **no port**: nothing on the machine or the
network can reach it but the relay, and it needs no token of its own. The child
receives only the Doris settings (`dorisChildEnv`); the signing key and the
other stores' passwords never reach it.

The Worker registers Doris MCP's eight domain tools under their own names and
passes calls through unchanged, so the discovery flow (`{}` → children →
`child_tool` + `arguments` + `manifest_version`) works exactly as Apache
documents it. All eight need only `doris:access`; there is no Doris write tool
because Doris MCP 1.0 has none.

## 6. Least-privilege credentials, per store

Every credential below is new and used only by the data MCP. None of them can
manage users or roles.

### MongoDB Atlas (`nyuchi-platform-doc-db`)

- `nyuchi_mcp_ro`: built-in roles `readAnyDatabase` and `clusterMonitor` (both
  on `admin`), scoped to the cluster. Covers every read tool, including
  `serverStatus`, `currentOp` and `connectionStatus`.
- `nyuchi_mcp_rw` (optional, create only when writes are wanted):
  `readWriteAnyDatabase` + `dbAdminAnyDatabase`, scoped to the cluster.
  **Never** `userAdmin*`, `atlasAdmin` or `root` (README, "Why there is no user
  or role management").

```sh
atlas dbusers create --username nyuchi_mcp_ro \
  --role readAnyDatabase@admin,clusterMonitor@admin \
  --scope nyuchi-platform-doc-db --projectId <atlas-project-id>
# The CLI prompts for the password when --password is omitted; paste
# MONGODB_MCP_RO_PASSWORD from 1Password. Or use Atlas UI → Database Access.
```

Connection string: `mongodb+srv://nyuchi_mcp_ro:<password>@<cluster-host>/?authSource=admin&appName=nyuchi-data-mcp`.
The password is generated as hex, so it needs no URL-encoding. Workers have no
fixed egress IP; the cluster's network access list must already admit
Cloudflare (it does for today's worker).

### Supabase (each of the four projects)

A login role with `SELECT` on the application schema only — not
`pg_read_all_data`, which would include `auth.users` (password hashes) and
`vault`:

```sql
create role nyuchi_mcp_ro login password '<SUPABASE_<KEY>_MCP_RO_PASSWORD>';
grant usage on schema public to nyuchi_mcp_ro;
grant select on all tables in schema public to nyuchi_mcp_ro;
alter default privileges for role postgres in schema public
  grant select on tables to nyuchi_mcp_ro;
alter role nyuchi_mcp_ro set default_transaction_read_only = on;
alter role nyuchi_mcp_ro set statement_timeout = '15s';
```

Repeat the `usage`/`select`/`default privileges` lines for any other
application schema. Row-level security still applies to this role; if
operator reads must see RLS-protected rows, add `alter role nyuchi_mcp_ro
bypassrls;` deliberately — it is what makes the role an operator credential.

Connection string, through Supavisor in **transaction mode** (port 6543; the
driver runs with `prepare: false` for it):
`postgresql://nyuchi_mcp_ro.<project-ref>:<password>@<pooler-host>:6543/postgres`.
For `nyuchi_relational_db` the ref is `ponbvierjjqsbvvkkafl` and the pooler
host `aws-1-eu-west-1.pooler.supabase.com`; for the others copy both from the
dashboard (Connect → Transaction pooler).

A write role, if ever wanted, is the same with `insert, update, delete`
instead of `select`, without `default_transaction_read_only`, stored as
`SUPABASE_<KEY>_RW_URL`.

### Doris (`mukoko-doris`)

`data-infra#1` (`fix/doris-auth-and-logging`) adds `ensure_service_user` to the
Doris entrypoint and already uses it for `gateway_ro`. Add one line beside it:

```sh
ensure_service_user nyuchi_mcp_ro DORIS_MCP_RO_PASSWORD "SELECT_PRIV"
```

That creates `'nyuchi_mcp_ro'@'%'` with `SELECT_PRIV` on the `mukoko`
database, and resets its password from the secret on every boot. The manual
equivalent, as root from the machine:

```sql
CREATE USER 'nyuchi_mcp_ro'@'%' IDENTIFIED BY '<DORIS_MCP_RO_PASSWORD>';
GRANT SELECT_PRIV ON internal.mukoko.* TO 'nyuchi_mcp_ro'@'%';
```

Doris MCP's cluster and audit children need `ADMIN_PRIV`/`NODE_PRIV`; they are
deliberately not granted, and Doris MCP reports those children as
`callable=false` rather than failing open. Do not point it at `root` or
`admin`, which bypass Doris's fine-grained controls.

### Cassandra (`nyuchi-cassandra`)

`data-infra#2` creates roles with `ensure_role` in `cassandra/entrypoint.sh`.
Add, beside `nyuchi_api`:

```sh
ensure_role CASSANDRA_MCP_RO_PASSWORD nyuchi_mcp_ro "SELECT ON KEYSPACE ${NHAKA_KEYSPACE}" || rc=1
```

`system_schema` is readable by every authenticated role, so listing keyspaces
and describing tables works with no further grant; `system_auth` (password
hashes) is not granted. A write role, if wanted:
`ensure_role CASSANDRA_MCP_RW_PASSWORD nyuchi_mcp_rw "SELECT ON KEYSPACE ${NHAKA_KEYSPACE}" "MODIFY ON KEYSPACE ${NHAKA_KEYSPACE}"`
— never `ALTER`, `DROP`, `CREATE` or `AUTHORIZE`.

### JanusGraph (`nyuchi-janusgraph`)

Gremlin Server has one user today (`nyuchi_api`) and no per-user
authorisation. Until that changes, read-only is enforced by the relay:

- the read tools take **structured arguments**, never Gremlin text; the relay
  builds the traversal and attaches TinkerPop's `ReadOnlyStrategy`, which the
  server enforces by rejecting any mutating step;
- raw Gremlin (`graph_gremlin`) is a **write** tool: a Groovy script can do
  anything the user can, so it needs `graph:write` and `graph` in
  `RELAY_ALLOW_WRITES`.

Follow-up in `data-infra` (not in this PR): a second Gremlin user
`nyuchi_mcp` restricted by Gremlin Server's `AllowListAuthorizer` to a
read-only traversal source (`g_ro`, bound with `ReadOnlyStrategy`) and no
script sandbox. The relay then sets `GREMLIN_USER=nyuchi_mcp` and the graph
read path no longer shares a credential that can write.

## 7. Secrets: 1Password fields and where they go

Vault **Bundu Infrastructure**, one item per repository titled
`<org>/<repo>`, one concealed field per environment variable.

| 1Password item      | Field                                 | Pushed to                                            | Notes                                                       |
| ------------------- | ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `nyuchi/data-mcp`   | `COOKIE_ENCRYPTION_KEY`               | Worker `mongodb-mcp`                                 | generate (hex32); replacing it only resets approval cookies |
| `nyuchi/data-mcp`   | `RELAY_SIGNING_SECRET`                | Worker `mongodb-mcp` **and** Fly `nyuchi-data-relay` | generate (hex32); same value on both sides                  |
| `nyuchi/data-mcp`   | `MONGODB_MCP_RO_PASSWORD`             | — (used to create the Atlas user)                    | generate (hex32)                                            |
| `nyuchi/data-mcp`   | `MONGODB_RO_URI`                      | Worker `mongodb-mcp`                                 | built from the password and the cluster host                |
| `nyuchi/data-mcp`   | `MONGODB_MCP_RW_PASSWORD`             | —                                                    | optional, only with a write user                            |
| `nyuchi/data-mcp`   | `MONGODB_RW_URI`                      | Worker `mongodb-mcp`                                 | optional                                                    |
| `nyuchi/data-mcp`   | `SUPABASE_RELATIONAL_MCP_RO_PASSWORD` | — (used in the role SQL)                             | generate (hex32)                                            |
| `nyuchi/data-mcp`   | `SUPABASE_RELATIONAL_RO_URL`          | Worker `mongodb-mcp`                                 |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_PAY_MCP_RO_PASSWORD`        | —                                                    |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_PAY_RO_URL`                 | Worker `mongodb-mcp`                                 |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_SHAMWARI_MCP_RO_PASSWORD`   | —                                                    |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_SHAMWARI_RO_URL`            | Worker `mongodb-mcp`                                 |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_MZIZI_MCP_RO_PASSWORD`      | —                                                    |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_MZIZI_RO_URL`               | Worker `mongodb-mcp`                                 |                                                             |
| `nyuchi/data-mcp`   | `SUPABASE_<KEY>_RW_URL`               | Worker `mongodb-mcp`                                 | optional, per project, only with a write role               |
| `nyuchi/data-infra` | `DORIS_MCP_RO_PASSWORD`               | Fly `mukoko-doris` and Fly `nyuchi-data-relay`       | generate (hex32)                                            |
| `nyuchi/data-infra` | `CASSANDRA_MCP_RO_PASSWORD`           | Fly `nyuchi-cassandra` and Fly `nyuchi-data-relay`   | generate (hex32)                                            |
| `nyuchi/data-infra` | `CASSANDRA_MCP_RW_PASSWORD`           | Fly `nyuchi-cassandra` and Fly `nyuchi-data-relay`   | optional                                                    |
| `nyuchi/data-infra` | `GREMLIN_PASSWORD`                    | Fly `nyuchi-data-relay`                              | already exists (JanusGraph step)                            |
| `nyuchi/workos`     | `WORKOS_AUTHKIT_DOMAIN`               | Worker `mongodb-mcp`                                 | already exists (`workos_domains` step)                      |

`WORKOS_AUTHKIT_DOMAIN` moves from a `wrangler.jsonc` var to a secret: the var
held the retired `identity.nyuchi.com`, and a var and a secret of the same name
cannot coexist on a Worker. The old `MONGODB_URI` secret is no longer read;
delete it after the switch (`wrangler secret delete MONGODB_URI --name mongodb-mcp`).

### A step for `~/GitHub/owner-actions.sh`

Written against the script's own helpers (`need`, `op_ensure`, `op_get`,
`op_put`, `to_worker`, `to_fly`, `confirm`, `pause`, `run`); values travel
pipe to pipe and never through arguments or the terminal.

```bash
supabase_mcp_ro_sql() { # supabase_mcp_ro_sql <password> — the role SQL (section 6)
  printf "create role nyuchi_mcp_ro login password '%s';
grant usage on schema public to nyuchi_mcp_ro;
grant select on all tables in schema public to nyuchi_mcp_ro;
alter default privileges for role postgres in schema public grant select on tables to nyuchi_mcp_ro;
alter role nyuchi_mcp_ro set default_transaction_read_only = on;
alter role nyuchi_mcp_ro set statement_timeout = '15s';" "$1"
}

step_data_mcp() {
  need op gh wrangler fly || return
  local repo=nyuchi/data-mcp infra=nyuchi/data-infra dir="$GH/nyuchi/data-mcp" k spec name ref pooler host
  [[ -d "$dir" ]] || dir="$GH/nyuchi/mongodb-mcp"
  bold "Data MCP: credentials, 1Password, Worker secrets, relay"

  for k in COOKIE_ENCRYPTION_KEY RELAY_SIGNING_SECRET MONGODB_MCP_RO_PASSWORD \
    SUPABASE_RELATIONAL_MCP_RO_PASSWORD SUPABASE_PAY_MCP_RO_PASSWORD \
    SUPABASE_SHAMWARI_MCP_RO_PASSWORD SUPABASE_MZIZI_MCP_RO_PASSWORD; do
    op_ensure "$repo" "$k"
  done
  op_ensure "$infra" DORIS_MCP_RO_PASSWORD
  op_ensure "$infra" CASSANDRA_MCP_RO_PASSWORD

  info "Atlas: create nyuchi_mcp_ro (readAnyDatabase + clusterMonitor, scoped to nyuchi-platform-doc-db)"
  info "with the password in 1Password $repo/MONGODB_MCP_RO_PASSWORD."
  if confirm "Build MONGODB_RO_URI now?"; then
    read -r -p "  Atlas SRV host (e.g. nyuchi-platform-doc-db.xxxxx.mongodb.net): " host
    [[ "$DRY_RUN" == 1 ]] || printf 'MONGODB_RO_URI=mongodb+srv://nyuchi_mcp_ro:%s@%s/?authSource=admin&appName=nyuchi-data-mcp\n' \
      "$(op_get "$repo" MONGODB_MCP_RO_PASSWORD)" "$host" | op_put "$repo"
  fi

  for spec in RELATIONAL:nyuchi_relational_db PAY:nyuchi_pay_db SHAMWARI:shamwari_ai_db MZIZI:mzizi_db; do
    k="${spec%%:*}"; name="${spec##*:}"
    confirm "Create the read-only role on $name?" || continue
    read -r -p "  $name project ref: " ref
    read -r -p "  $name transaction pooler host (Connect → Transaction pooler): " pooler
    [[ "$DRY_RUN" == 1 ]] || supabase_mcp_ro_sql "$(op_get "$repo" "SUPABASE_${k}_MCP_RO_PASSWORD")" | pbcopy
    pause "Ran it in https://supabase.com/dashboard/project/$ref/sql (then clear your clipboard)"
    [[ "$DRY_RUN" == 1 ]] || printf 'SUPABASE_%s_RO_URL=postgresql://nyuchi_mcp_ro.%s:%s@%s:6543/postgres\n' \
      "$k" "$ref" "$(op_get "$repo" "SUPABASE_${k}_MCP_RO_PASSWORD")" "$pooler" | op_put "$repo"
  done

  confirm "Push the Worker secrets (Worker mongodb-mcp)?" && {
    to_worker "$dir" mongodb-mcp COOKIE_ENCRYPTION_KEY="$repo:COOKIE_ENCRYPTION_KEY" \
      RELAY_SIGNING_SECRET="$repo:RELAY_SIGNING_SECRET" MONGODB_RO_URI="$repo:MONGODB_RO_URI"
    for k in RELATIONAL PAY SHAMWARI MZIZI; do
      op_has "$repo" "SUPABASE_${k}_RO_URL" && to_worker "$dir" mongodb-mcp "SUPABASE_${k}_RO_URL=$repo:SUPABASE_${k}_RO_URL"
    done
  }

  fly apps list | grep -q nyuchi-data-relay ||
    { confirm "Create Fly app nyuchi-data-relay?" && run fly apps create nyuchi-data-relay --org nyuchi-web-services; }
  to_fly nyuchi-data-relay RELAY_SIGNING_SECRET="$repo:RELAY_SIGNING_SECRET" \
    DORIS_MCP_RO_PASSWORD="$infra:DORIS_MCP_RO_PASSWORD" \
    CASSANDRA_MCP_RO_PASSWORD="$infra:CASSANDRA_MCP_RO_PASSWORD" \
    GREMLIN_PASSWORD="$infra:GREMLIN_PASSWORD"
  info "Staged for the store side (they apply with the data-infra changes in section 6):"
  to_fly mukoko-doris DORIS_MCP_RO_PASSWORD="$infra:DORIS_MCP_RO_PASSWORD"
  to_fly nyuchi-cassandra CASSANDRA_MCP_RO_PASSWORD="$infra:CASSANDRA_MCP_RO_PASSWORD"
  confirm "Deploy the relay?" && (cd "$dir" && run fly deploy . --config relay/fly.toml --dockerfile relay/Dockerfile)
  run curl -fsS https://nyuchi-data-relay.fly.dev/healthz; echo
  info "An unsigned call must be refused (401):"
  run curl -s -o /dev/null -w '%{http_code}\n' -X POST https://nyuchi-data-relay.fly.dev/v1/call
}
```

## 8. Owner steps, in order

1. **Rename the repository**: `gh repo rename data-mcp -R nyuchi/mongodb-mcp`,
   then move the local clone (section 1).
2. **WorkOS** (Authorization → Permissions), create the ten permissions:
   `mongodb:access`, `mongodb:write`, `supabase:access`, `supabase:write`,
   `doris:access`, `doris:write`, `cassandra:access`, `cassandra:write`,
   `graph:access`, `graph:write` (`mongodb:access` exists already). Attach the
   five `:access` ones to the owner's role; attach a `:write` one only when
   writes to that store are wanted. In the Connect application, add the
   redirect URI `https://data.nyuchi.dev/callback` (keep
   `https://mongodb.nyuchi.dev/callback`). Do this **before** deploying: the
   Worker requests all ten scopes, and a scope WorkOS does not know may fail
   the sign-in. Then confirm on a test sign-in that a user lacking some of them
   still signs in with the subset (the design relies on WorkOS omitting, not
   rejecting, scopes the role does not hold).
3. **Store credentials** (section 6): Atlas `nyuchi_mcp_ro`; the Supabase role
   on each project; the one-line additions to `data-infra#1` (Doris) and
   `data-infra#2` (Cassandra), then the Doris and Cassandra deploys that apply
   them.
4. **1Password and pushes**: the `step_data_mcp` step above.
5. **Fly**: the step creates `nyuchi-data-relay` in `nyuchi-web-services`,
   stages its secrets and deploys it from the repository root. Check
   `fly ips list -a nyuchi-data-relay` shows the shared IPv4 and an IPv6, that
   `/healthz` answers 200 and an unsigned `POST /v1/call` answers 401.
6. **Deploy the Worker** — by merging this PR. The `mongodb-mcp` Worker is
   connected to **Cloudflare Workers Builds**, which deploys `main` to
   production on every merge, so **do not merge until steps 1–5 are done**
   (otherwise the deployed worker requests scopes WorkOS does not know and has
   no `MONGODB_RO_URI`). `npm run deploy` does the same by hand. The
   `data.nyuchi.dev` custom-domain route makes Cloudflare create the DNS record
   and certificate itself (the `nyuchi.dev` zone is in the same account); only
   if a record for `data.nyuchi.dev` already exists does it need removing
   first. Immediately after the deploy, push `WORKOS_AUTHKIT_DOMAIN`
   (`to_worker … WORKOS_AUTHKIT_DOMAIN=nyuchi/workos:WORKOS_AUTHKIT_DOMAIN`, as
   the `workos_domains` step does): the deploy removes the old var, and until
   the secret lands new sign-ins fail (existing sessions keep working).
7. **Clients**: point them at `https://data.nyuchi.dev/mcp`. Tool names now
   carry their store prefix (`mongodb_find`).
8. **Later**: delete the `MONGODB_URI` secret; when no client uses
   `mongodb.nyuchi.dev`, drop that route; rename the Worker to `data-mcp`
   (a new Worker name is a new script — deploy it, move the custom domains,
   then delete `mongodb-mcp`; the `OAUTH_KV` namespace can be reused by id).

## 9. Costs

The relay is one `shared-cpu-1x` machine with 1 GB (Doris MCP brings pandas
and pyarrow) that stops when idle and starts on the next request — a few
dollars a month at most. Everything else already exists.

## 10. Open questions

- WorkOS behaviour when a requested scope is not held by the user's role
  (omit vs reject) — to confirm in step 2.
- Project refs and pooler hosts for `nyuchi_pay_db`, `shamwari_ai_db` and
  `mzizi_db` (some may live in another Supabase organisation).
- Whether operator Supabase reads need `bypassrls` (section 6).
- The JanusGraph read-only user (section 6) — until then, graph reads share
  `nyuchi_api`'s credential, guarded by `ReadOnlyStrategy`.

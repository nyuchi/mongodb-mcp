# CLAUDE.md

Project-specific guidance for Claude Code working in this repo.

## What this is

Authenticated remote **MCP server** for managing MongoDB. Runs on Cloudflare
Workers, served at `https://mongodb.nyuchi.dev/mcp`. A WorkOS **OAuth**
(Authorization Code + PKCE) gate fronts `/mcp`; the endpoint never accepts
unauthenticated traffic. Internal, platform-team-only.

The Fundi place-ingestion worker (`https://fundi-ingestion.nyuchi.dev/mcp`)
used to live here under `fundi/`; it moved to `nyuchi/barstool`
(`workers/fundi-ingestion/`) — Kweli is the places app, so place ingestion
lives with it. This repo is the MongoDB MCP only.

## Architecture in one breath

`@cloudflare/workers-oauth-provider` wraps the worker: it serves `/authorize`,
`/token`, `/register` and gates `/mcp`. `AuthkitHandler` (`src/authkit-handler.ts`)
runs the WorkOS redirect/callback dance — it sends the user to WorkOS, then on
`/callback` exchanges the code (PKCE), enforces the org allowlist + the granted
permission scope, and completes the OAuth grant. Authorized requests reach a
**stateless** `/mcp` handler: `createMcpHandler` (`agents/mcp/server`, MCP SDK
v2) builds a fresh `McpServer` per request and registers all tools from
`src/tools.ts`.

There is no Durable Object. The `MongoClient` is cached at **isolate** scope in
`src/index.ts` instead of per session, so the driver's pool still amortises
across requests that land on the same isolate. The client is built inside the
request path (workerd forbids sockets at module scope) and the cached promise
is cleared on a failed connect so one bad attempt cannot poison the isolate.

## Where things live

| Path                         | Purpose                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/index.ts`               | `OAuthProvider` wiring + stateless `/mcp` handler; isolate-scoped `MongoClient` cache.           |
| `src/authkit-handler.ts`     | WorkOS OAuth flow: `/authorize`, `/callback`, org + permission gate.                             |
| `src/workers-oauth-utils.ts` | OAuth approval-dialog + client-approval cookie helpers.                                          |
| `src/tools.ts`               | All MCP tool definitions + annotations + `permissionHint` / `fail` / `assertNotIdentityCommand`. |
| `src/icon.ts`                | Inline MCP Tools logo SVG served at `/icon.svg`.                                                 |
| `src/mongo.ts`               | `buildClient(uri)` + re-exports of EJSON helpers.                                                |
| `src/ejson.ts`               | Extended-JSON parse/stringify with a 256 KiB output cap.                                         |
| `src/landing.ts`             | Static landing page served at `/` — **public**, and it documents the tool surface.               |
| `src/props.ts`               | Type of the auth props the OAuth provider hands the API handler.                                 |
| `src/native-stub.js`         | No-op stand-in for the driver's native optional deps (aliased in `wrangler.jsonc`).              |
| `test/tools.test.ts`         | Tool catalogue, annotations, and the security invariants (see below).                            |
| `test/handler.test.ts`       | Drives the real stateless `/mcp` handler end to end inside `workerd`.                            |
| `test/mongo.test.ts`         | Extended-JSON helpers and the 256 KiB truncation cap.                                            |
| `test/oauth-utils.test.ts`   | Client-approval cookie signing + approval-dialog helpers.                                        |
| `.github/workflows/`         | `ci.yml`, `lint.yml`, `security.yml`, `auto-tag.yml`, `release.yml`, `auto-assign.yml`.          |
| `wrangler.jsonc`             | Production worker config; `OAUTH_KV` binding lives here.                                         |
| `wrangler.test.jsonc`        | Worker config used by the vitest pool — keep test bindings here.                                 |

## Commands

```sh
npm install
npm run dev            # wrangler dev — needs .dev.vars (see .dev.vars.example)
npm test               # vitest, runs inside workerd
npm run type-check     # tsc --noEmit
npm run deploy         # wrangler deploy
```

## CI and test infrastructure

Three workflows gate every pull request and every push to `main`. Run their
fast equivalents locally before pushing — a red check costs a review cycle.

| Workflow       | What it enforces                                                                                                         | Local equivalent                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `ci.yml`       | `tsc --noEmit`; `vitest run` inside `workerd`; `wrangler deploy --dry-run` so bundle/config breakage fails before deploy | `npm run type-check && npm test` |
| `lint.yml`     | org reusable lint: `prettier --check`, `markdownlint`, `yamllint`, `actionlint`, JSON validity                           | `npx prettier --write <files>`   |
| `security.yml` | `npm audit --omit=dev --audit-level=high`, `dependency-review-action` (fails on high), `gitleaks` — plus a weekly cron   | `npm audit --omit=dev`           |

CodeQL runs via GitHub's Default Setup, not a workflow here — adding an
advanced CodeQL workflow would conflict with it and both would fail.

### What the tests guard, and what they do not

`test/tools.test.ts` is the security spec for the tool surface, not just a
smoke test. It asserts today that:

- the registered catalogue matches an explicit `expected` list **exactly**, so
  adding a tool without listing it fails the build;
- no identity-management tool is registered, by name;
- `runCommand` refuses user/role commands (`assertNotIdentityCommand`);
- every irreversible tool rejects `confirm: false` and `confirm: undefined`;
- `deleteMany` refuses an empty or missing filter unless confirmed;
- every tool carries a non-empty `title`, `description`, and boolean
  `readOnlyHint` / `destructiveHint`.

`test/handler.test.ts` re-checks the identity invariants against the real
handler in `workerd`, so a guard that exists in `tools.ts` but is bypassed by
the wiring still fails.

These invariants are **derived, not transcribed** — they read the exported
`READ` / `ADD` / `MUTATE` presets and `IDENTITY_COMMANDS` from `src/tools.ts`,
so they cannot drift out of step with the registry by someone updating one file
and not the other:

- **Annotations are checked for correctness.** A tool's `readOnlyHint` /
  `destructiveHint` pair must be one of the three preset shapes, never both
  true; read-shaped names (`list*`, `get*`, `*Stats`, and a named list) must be
  read-only and non-destructive; mutating names (`drop*`, `delete*`, `update*`,
  `replace*`, `findOneAnd*`, …) must be destructive and not read-only; read-only
  implies idempotent; and `openWorldHint` is reserved for `runCommand`. Clients
  auto-approve on `readOnlyHint`, so a destructive tool wearing it is a way to
  get an unattended drop past a human.
- **Every `IDENTITY_COMMANDS` entry** is asserted refused through `runCommand`
  in three casings, plus one smuggled in beside benign keys, plus a pinned list
  of privilege-granting commands the set must keep.
- **Destructive-shaped tools must be classified.** Anything matching
  `/^(drop|truncate|remove|purge)/` has to appear in the test's `GATED` list or
  in `UNGATED_BY_DESIGN` — a new one cannot default to ungated by nobody
  thinking about it. (`dropIndex` and `dropSearchIndex` are ungated on purpose:
  an index is cheap to rebuild, a collection is not.)
- **`test/access-gate.test.ts`** exercises `checkAccess` from
  `src/authkit-handler.ts` exhaustively, including that it **fails closed**.

**The gate fails closed, deliberately.** An unset or blank
`WORKOS_ALLOWED_ORG_IDS` or `WORKOS_REQUIRED_PERMISSION` returns 500 and admits
nobody. Treating absent config as "no restriction" would let any WorkOS user of
any organization reach the tool surface — it read as a safe default and was the
opposite. Do not reintroduce a `length > 0 &&` or truthiness guard around
either check.

When changing a guard, verify the test can actually fail: break the guard on
purpose, watch the suite go red, then restore it. Every invariant above was
confirmed that way.

## Conventions to keep

- **Every tool returns `ok(value)` or `fail(err)`.** Never throw out of a
  handler; the wrappers shape the MCP response and `fail()` enriches auth
  errors with a hint. New tools must use them.
- **Inputs go through `parseExtendedJson`** so callers can pass `$oid`, `$date`,
  etc. Outputs go through `stringifyEJson` (which also truncates at 256 KiB).
- **Irreversible ops gate on `confirm`.** `dropCollection`, `dropDatabase`,
  `dropIndexes`, `convertToCapped`, `enableSharding` and `shardCollection`
  require `confirm: z.literal(true)`. `deleteMany` requires `confirm: true`
  only when the filter is empty / matches everything. A test asserts the gate
  holds for every tool on that list.
- **`tools.ts` must not value-import from `mongodb`.** Type-only imports
  (`import type { … } from "mongodb"`) are fine and get erased — value
  imports of the driver crash the vitest workerd loader. Use `./ejson`
  directly for EJSON helpers, not `./mongo` (which value-imports `MongoClient`).
- **Zod schemas live inline next to the handler.** Reuse `dbArg`, `collArg`,
  `jsonDoc`, `jsonArray`. Add new shared shapes near the top of the file.
- **Every tool carries annotations.** Pass a `title` plus the behavioural
  hints (`readOnlyHint` / `destructiveHint` / `idempotentHint` /
  `openWorldHint`) via the `READ` / `ADD` / `MUTATE` presets so clients can
  auto-approve safe reads and warn before destructive ops. The test suite
  asserts every tool has them.
- **Never add user or role management tools.** They need `userAdmin`, which
  cannot be scoped — a credential that can create a user can create `root`,
  which defeats every other guard here. `runCommand` enforces the same rule via
  `assertNotIdentityCommand`; extend `IDENTITY_COMMANDS` if MongoDB adds to the
  family. See README → 'Why there is no user or role management'.
- **`src/landing.ts` is documentation with a public URL.** It lists the tool
  surface and the role requirements at <https://mongodb.nyuchi.dev>. Any change
  to which tools exist, or to what the `MONGODB_URI` credential should hold,
  has to land there in the same PR — v2.0.0 shipped without it and left the
  public page advertising removed tools and prescribing `userAdmin`.
- **No comments unless they explain _why_.** This repo follows the global
  rule — prefer expressive names over narration.

## Adding a new MCP tool

1. In `src/tools.ts`, call the local
   `tool(name, description, { …zodSchema }, annotations, async args => { … })`
   helper inside `registerMongoTools` — it wraps SDK v2's `registerTool`, lifts
   `title` out of the annotations and does the `z.object()` wrapping.
   Never call `server.registerTool` directly. Reuse `dbArg`/`collArg`/`jsonDoc`/`jsonArray` and
   one of the `READ` / `ADD` / `MUTATE` annotation presets (add `title:`, plus
   `idempotentHint`/`openWorldHint` overrides where they differ).
2. The handler body: `try { const client = await getClient(); … return ok(result); } catch (e) { return fail(e); }`.
3. If the operation maps to a non-`readWrite` MongoDB privilege, mention it in
   the README's "MongoDB user role requirements" table so `permissionHint`'s
   pointer stays accurate.
4. Add the tool name to the `expected` list in `test/tools.test.ts` (the size
   assertion fails otherwise) and add a focused unit test if the handler does
   anything beyond a thin driver call. If the tool is irreversible, add it to
   the `gated` list in the confirm-gate test too.
5. Update the "Available tools" section of `README.md` **and** the tool list in
   `src/landing.ts` — the latter is the public page and is easy to forget.

## Auth / permissions reference

- WorkOS OAuth gate: MCP clients sign in via WorkOS AuthKit Authorization Code
  with PKCE against the **Connect** application. `AuthkitHandler` sends the user
  to `${WORKOS_AUTHKIT_DOMAIN}/oauth2/authorize` with `organization_id` pinned
  and requests `WORKOS_REQUIRED_PERMISSION` (`mongodb:access`) **as an OAuth
  scope** — the Connect app exposes permissions as scopes. On `/callback` the
  worker exchanges the code, then gates on two things from the access token:
  `org_id` must be in `WORKOS_ALLOWED_ORG_IDS`, and the required permission must
  appear in the granted `scope` claim (WorkOS only grants it when the user's org
  role holds it). Env: `WORKOS_CLIENT_ID`, `WORKOS_AUTHKIT_DOMAIN`,
  `WORKOS_ORGANIZATION_ID`, `WORKOS_ALLOWED_ORG_IDS`, `WORKOS_REQUIRED_PERMISSION`;
  secrets `COOKIE_ENCRYPTION_KEY` and `MONGODB_URI`; `OAUTH_KV` stores PKCE/grant
  state. Note: the Connect/OAuth token surfaces permissions via the `scope`
  claim, not a `permissions` array — gate on the granted scope.
- MongoDB gate: the `MONGODB_URI` user must hold the privilege for whichever
  tool is invoked. See the role table in the README. `permissionHint()`
  detects codes 13/18/31/33 and `"not authorized on"` messages, then appends
  a role-grant pointer to the error response. That credential must **never**
  hold `userAdmin` / `userAdminAnyDatabase` / `root`: nothing here needs them
  and they cannot be scoped, so granting one would let any caller escalate.

## Workers-runtime gotchas

- `mongodb` driver only runs because `nodejs_compat` is enabled. It opens
  TCP sockets, which is allowed _only inside a request handler_ — never at
  module scope. The `getClient()` helper enforces this.
- The `/mcp` endpoint is stateless — no Durable Object, no server-side
  session. Connection reuse comes from caching the `MongoClient` at isolate
  scope in `src/index.ts`; keep that cache lazily created inside the request
  path, never at module scope.
- Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`. Modules
  that value-import CommonJS-only packages (notably the `mongodb` driver)
  blow up at import time — keep them out of any file the tests transitively
  load.
- `bson` is pinned to `7.2.0` via `overrides`. 7.3.0 generates random bytes in
  `ObjectId`'s module-scope static initializer, which workerd rejects
  ("Disallowed operation called within global scope") at startup validation.
- `fast-uri` and `ip-address` are floored via `overrides` to clear high-severity
  advisories that `security.yml`'s `npm audit --omit=dev --audit-level=high` job
  fails on. They reach us transitively through `@modelcontextprotocol/sdk`
  (`ajv` and `express-rate-limit`); drop the overrides once the SDK ships
  patched ranges. **The floor is not set once.** A new advisory can extend a
  vulnerable range over the version we pinned — that is how `^3.1.5` went red —
  so when `npm audit` fails on one of these, raise the floor past the advisory's
  range and refresh the lockfile with `npm install --package-lock-only`. Only
  `high` and above fail the gate; moderate findings are reported, not blocking.
- `agents@0.21` imports `@modelcontextprotocol/server` and
  `@modelcontextprotocol/client` (MCP SDK v2) at module scope even on the
  legacy `McpAgent` path, and `.npmrc` sets `legacy-peer-deps=true`, so both
  are listed as direct dependencies. Drop them and the bundle fails to
  resolve.

## Release flow

Pushes to `main` trigger `.github/workflows/auto-tag.yml`, which inspects
conventional-commit prefixes since the last tag and pushes an annotated
semver tag (`feat:` → minor, `fix:`/`perf:` → patch, `BREAKING CHANGE:` →
major). The tag push triggers `release.yml`, which delegates to
`nyuchi/.github/.github/workflows/reusable-release.yml` for SBOM + GitHub
release notes. The `RELEASE_BUMP_TOKEN` PAT lets the auto-tag workflow push
under a user identity so downstream tag-triggered workflows fire.

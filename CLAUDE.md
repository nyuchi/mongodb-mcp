# CLAUDE.md

Project-specific guidance for Claude Code working in this repo.

## What this is

Authenticated remote **MCP server** for managing MongoDB. Runs on Cloudflare
Workers, served at `https://mongodb.nyuchi.dev/mcp`. A WorkOS **OAuth**
(Authorization Code + PKCE) gate fronts `/mcp`; the endpoint never accepts
unauthenticated traffic. Internal, platform-team-only.

The repo also hosts a second worker under `fundi/` — the Fundi place-ingestion
MCP (`https://fundi-ingestion.nyuchi.dev/mcp`). It shares the same WorkOS OAuth
gate and conventions; see `fundi/src/`.

## Architecture in one breath

`@cloudflare/workers-oauth-provider` wraps the worker: it serves `/authorize`,
`/token`, `/register` and gates `/mcp`. `AuthkitHandler` (`src/authkit-handler.ts`)
runs the WorkOS redirect/callback dance — it sends the user to WorkOS, then on
`/callback` exchanges the code (PKCE), enforces the org allowlist + the granted
permission scope, and completes the OAuth grant. Authorized sessions reach
`MongoMcp` (a Durable Object subclass of `McpAgent`) which caches one
`MongoClient` per session and registers all tools from `src/tools.ts`.

## Where things live

| Path                         | Purpose                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `src/index.ts`               | `OAuthProvider` wiring + the `MongoMcp` DO; serves `/mcp`.           |
| `src/authkit-handler.ts`     | WorkOS OAuth flow: `/authorize`, `/callback`, org + permission gate. |
| `src/workers-oauth-utils.ts` | OAuth approval-dialog + client-approval cookie helpers.              |
| `src/tools.ts`               | All MCP tool definitions + annotations + `permissionHint` / `fail`.  |
| `src/icon.ts`                | Inline MCP Tools logo SVG served at `/icon.svg`.                     |
| `src/mongo.ts`               | `buildClient(uri)` + re-exports of EJSON helpers.                    |
| `src/ejson.ts`               | Extended-JSON parse/stringify with a 256 KiB output cap.             |
| `src/landing.ts`             | Static landing page served at `/`.                                   |
| `fundi/`                     | The Fundi ingestion worker (own `src/`, `wrangler.jsonc`, tests).    |
| `test/`                      | Vitest specs (run inside `workerd` via the Cloudflare pool).         |
| `wrangler.jsonc`             | Production worker config; DO + `OAUTH_KV` bindings live here.        |
| `wrangler.test.jsonc`        | Worker config used by the vitest pool — keep test bindings here.     |

## Commands

```sh
npm install
npm run dev            # wrangler dev — needs .dev.vars (see .dev.vars.example)
npm test               # vitest, runs inside workerd
npm run type-check     # tsc --noEmit
npm run deploy         # wrangler deploy
```

CI also runs `prettier --check`, `markdownlint`, `yamllint`, `actionlint`, and
JSON validity — fix locally with `npx prettier --write <files>` before pushing.

## Conventions to keep

- **Every tool returns `ok(value)` or `fail(err)`.** Never throw out of a
  handler; the wrappers shape the MCP response and `fail()` enriches auth
  errors with a hint. New tools must use them.
- **Inputs go through `parseExtendedJson`** so callers can pass `$oid`, `$date`,
  etc. Outputs go through `stringifyEJson` (which also truncates at 256 KiB).
- **Destructive ops gate on `confirm`.** `dropCollection` and `dropUser`
  require `confirm: z.literal(true)`. `deleteMany` requires `confirm: true`
  only when the filter is empty / matches everything.
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
- **No comments unless they explain _why_.** This repo follows the global
  rule — prefer expressive names over narration.

## Adding a new MCP tool

1. In `src/tools.ts`, call
   `server.tool(name, description, { …zodSchema }, annotations, async args => { … })`
   inside `registerMongoTools`. Reuse `dbArg`/`collArg`/`jsonDoc`/`jsonArray` and
   one of the `READ` / `ADD` / `MUTATE` annotation presets (add `title:`, plus
   `idempotentHint`/`openWorldHint` overrides where they differ).
2. The handler body: `try { const client = await getClient(); … return ok(result); } catch (e) { return fail(e); }`.
3. If the operation maps to a non-`readWrite` MongoDB privilege, mention it in
   the README's "MongoDB user role requirements" table so `permissionHint`'s
   pointer stays accurate.
4. Add the tool name to the `expected` list in `test/tools.test.ts` and add a
   focused unit test if the handler does anything beyond a thin driver call.
5. Update the "Available tools" section of `README.md`.

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
  a role-grant pointer to the error response.

## Workers-runtime gotchas

- `mongodb` driver only runs because `nodejs_compat` is enabled. It opens
  TCP sockets, which is allowed _only inside a request handler_ — never at
  module scope. The `getClient()` helper enforces this.
- Durable Object instances are reused across many requests in one MCP
  session, which is why we cache the `MongoClient`. Don't move it out of the
  DO without a plan for connection pooling on Workers.
- Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`. Modules
  that value-import CommonJS-only packages (notably the `mongodb` driver)
  blow up at import time — keep them out of any file the tests transitively
  load.

## Release flow

Pushes to `main` trigger `.github/workflows/auto-tag.yml`, which inspects
conventional-commit prefixes since the last tag and pushes an annotated
semver tag (`feat:` → minor, `fix:`/`perf:` → patch, `BREAKING CHANGE:` →
major). The tag push triggers `release.yml`, which delegates to
`nyuchi/.github/.github/workflows/reusable-release.yml` for SBOM + GitHub
release notes. The `RELEASE_BUMP_TOKEN` PAT lets the auto-tag workflow push
under a user identity so downstream tag-triggered workflows fire.

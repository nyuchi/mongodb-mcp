# CLAUDE.md

Project-specific guidance for Claude Code working in this repo.

## What this is

Authenticated remote **MCP server** for managing MongoDB. Runs on Cloudflare
Workers, served at `https://mongodb.nyuchi.dev/mcp`. WorkOS AuthKit gates
every request; the `/mcp` endpoint never accepts unauthenticated traffic.

## Architecture in one breath

`OAuthProvider` (Cloudflare) handles the OAuth 2.1 dance → `AuthkitHandler`
redirects to WorkOS and captures user/org/permissions into `props` →
`MongoMcp` (a Durable Object subclass of `McpAgent`) caches one `MongoClient`
per session and registers all tools from `src/tools.ts`.

## Where things live

| Path                         | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `src/index.ts`               | Wires `OAuthProvider`, the `MongoMcp` DO, and the auth handler.  |
| `src/tools.ts`               | All MCP tool definitions + `permissionHint` / `fail` helpers.    |
| `src/mongo.ts`               | `buildClient(uri)` + re-exports of EJSON helpers.                |
| `src/ejson.ts`               | Extended-JSON parse/stringify with a 256 KiB output cap.         |
| `src/authkit-handler.ts`     | Hono app implementing `/`, `/authorize`, `/callback`.            |
| `src/workers-oauth-utils.ts` | CSRF, state-binding cookies, approved-clients HMAC.              |
| `src/props.ts`               | Type of `props` carried alongside each MCP session.              |
| `test/`                      | Vitest specs (run inside `workerd` via the Cloudflare pool).     |
| `wrangler.jsonc`             | Production worker config; KV namespace + DO binding live here.   |
| `wrangler.test.jsonc`        | Worker config used by the vitest pool — keep test bindings here. |

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
- **No comments unless they explain _why_.** This repo follows the global
  rule — prefer expressive names over narration.

## Adding a new MCP tool

1. In `src/tools.ts`, call `server.tool(name, description, { …zodSchema }, async args => { … })`
   inside `registerMongoTools`. Reuse `dbArg`/`collArg`/`jsonDoc`/`jsonArray`.
2. The handler body: `try { const client = await getClient(); … return ok(result); } catch (e) { return fail(e); }`.
3. If the operation maps to a non-`readWrite` MongoDB privilege, mention it in
   the README's "MongoDB user role requirements" table so `permissionHint`'s
   pointer stays accurate.
4. Add the tool name to the `expected` list in `test/tools.test.ts` and add a
   focused unit test if the handler does anything beyond a thin driver call.
5. Update the "Available tools" section of `README.md`.

## Auth / permissions reference

- WorkOS gate: optional. `WORKOS_ALLOWED_ORG_IDS` (comma-separated) limits
  which orgs can authenticate; `WORKOS_REQUIRED_PERMISSION` requires that
  permission claim in the issued JWT (granted via WorkOS roles).
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

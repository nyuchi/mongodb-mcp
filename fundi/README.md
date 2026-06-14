# Fundi — the Bundu/Mukoko agentic place-ingestion Worker

Fundi is a Cloudflare Worker that ingests places and entities into the Mukoko
platform. It is a **worker with an agent, skills, and an MCP surface built in** —
not a deterministic script. It accepts **tasks** and works through them, turning
any region into clean, sovereign, **tier-0** place and entity records.

It lives alongside the [`mongodb-mcp`](../README.md) worker in this repo and
writes to the same MongoDB platform cluster.

## The model (non-negotiables)

- **Existence ≠ verification.** Fundi creates records at `verificationTier: 0`
  and never raises the tier. Verification is a separate journey users walk later.
- **Place ≠ entity, but linked.** A _place_ is a location (`places.places`); an
  _entity_ is an organisation (`entity.entities`). When an OSM feature is a
  business, Fundi creates **both** — the place plus an unverified entity, linked
  via `primaryPlaceId` / `ownerEntityId`. Natural/owner-less places are owned by
  the **Bundu Commons** custodian entity `0192e000-c000-7000-8000-000000000001`.
- **Sovereign addressing.** `geo` (GeoJSON Point) is the bedrock and always
  present. `plusCode` (Open Location Code) is **computed locally in-Worker** — no
  API, no key, works forever. `what3words` is a replaceable convenience layer
  resolved at **write time only** and persisted; if it fails the record is still
  valid with `geo` + `plusCode`.
- **Built for scale.** No hardcoded single region. The engine is region-agnostic;
  **Africa is a config-driven boundary _guard_** (`FUNDI_BOUNDARY_BBOX`), liftable
  to global by changing one var.
- **Sovereignty via the provider registry.** Sources/skills config is read from
  MongoDB `integrations.providerConfigurations`; credentials are resolved **by
  reference** (the registry holds the _name_ of a Worker secret, never the secret).

## Architecture

```text
task sources ─▶ POST /tasks ─┐
   search-miss                ├─▶ Cloudflare Queue ─▶ FundiAgent (Durable Object)
   app empty-state            │     (fundi-tasks)         agent loop + skills
   ops MCP (seed_region) ─────┘                                  │
                                                                 ▼
                                            MongoDB  places.places + entity.entities
                                                     (tier-0, unverified)
        D1 ledger  ◀── status / dedup / audit / result summaries ──┘
```

Fundi is built on the **Cloudflare Agents SDK** (the `agents` package), the same
foundation the sibling MCP uses:

- **`FundiMcp`** (`extends McpAgent`) — the MCP surface, a Durable Object served
  at `/mcp`. Its tools are Fundi's capabilities (see below).
- **`FundiAgent`** (`extends Agent<Env, State>`) — the durable, stateful per-task
  executor. One instance per `taskId`. It holds the task's execution state, runs
  the skill loop, and uses the SDK's `this.schedule()` for durable retry/backoff
  instead of a hand-rolled retry loop.
- The **Cloudflare Queue** buffers tasks; the worker's `queue` handler routes each
  task to its `FundiAgent` via RPC. **D1** is the cross-task audit ledger. A light
  **cron** sweeps stragglers the agent's own retries could not resolve.

### The agent and its skills (`src/skills/`)

The agent frame is real so new skills register without rewriting the consumer.
Today's skills:

| Skill                       | What it does                                                                |
| --------------------------- | --------------------------------------------------------------------------- |
| `tile_region`               | Region → bounded Overpass tiles (continental coverage ≠ one call).          |
| `overpass_lookup`           | OSM/Overpass features per tile/category (`node+way`, `out tags center`).    |
| `compute_pluscode`          | Open Location Code from lat/lng, locally. Always runs.                      |
| `resolve_what3words`        | lat/lng → 3-word address (best-effort, write-time only).                    |
| `enrich_wikidata`           | `wikidata` tag → QID labels / `sameAs` / identifiers (best-effort).         |
| `generate_description`      | Workers AI (Kimi via the shamwari AI Gateway) **with the v10 hedge guard**. |
| `classify_place_and_entity` | OSM tags → business vs natural; `placeType[]` + `schemaOrgType`.            |
| `write_records`             | Idempotent upsert to `places.places` (+ linked `entity.entities`).          |

Per task: tile → for each tile `overpass_lookup` → **dedupe on OSM id across
tiles** (keep the richest element — the fix for the duplicate "Rhino Safari Camp"
rows) → for each unique feature: classify → `compute_pluscode` +
`resolve_what3words` + `enrich_wikidata` + (`generate_description` if no usable
one) → `write_records` → tally → update ledger.

### The description guard (§6, do not regress)

`generate_description` rejects model output that looks like a refusal/hedge/
meta-commentary, retries **once** with a stricter "reply SKIP if you lack info"
instruction, and stores **nothing** if it still hedges or returns `SKIP`. A clean
null beats a polluted string. See `src/skills/description.ts` (`isHedge`).

## MCP surface (`/mcp`)

| Tool               | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `seed_region`      | Enqueue a seed task (what search-miss / app empty-state call).   |
| `seed_admin_bulk`  | Run a generator (e.g. all African capitals, 20 km) → many tasks. |
| `task_status`      | Ledger lookup by task id.                                        |
| `compute_pluscode` | Direct Plus Code computation (testing).                          |
| `overpass_lookup`  | Direct read-only Overpass query (testing).                       |

The `POST /tasks` HTTP endpoint and the MCP `seed_region` tool are two faces of
the same enqueue path (`src/enqueue.ts`).

## Auth (platform team only) — WorkOS M2M

Fundi is internal: `/mcp` and `/tasks` are gated by **WorkOS M2M
(`client_credentials`)**. A caller exchanges its client id/secret at
`https://<authkit_domain>/oauth2/token` for a short-lived JWT, then calls Fundi
with `Authorization: Bearer <jwt>`. The worker verifies that JWT **statelessly**
against the environment JWKS — no OAuth redirect, no session KV (`m2m-auth.ts`):

- signature → `https://<authkit_domain>/oauth2/jwks`
- `iss` → `https://<authkit_domain>` (`WORKOS_AUTHKIT_DOMAIN`)
- `aud` → our M2M app client id(s) (`WORKOS_M2M_CLIENT_ID`)
- `org_id` → optional allowlist (`WORKOS_ALLOWED_ORG_IDS`)

It **fails closed**: with no M2M config the gate denies (503). `/tasks` also
accepts a static `FUNDI_API_TOKEN` bearer for simple server-to-server surfaces;
`/health` and `/` are open.

**Connecting a client:** Claude's hosted connector speaks OAuth, not
`client_credentials`, so consume Fundi from **Claude Code** (or a small proxy)
that exchanges the M2M credential for a token and sets the `Authorization`
header. `WORKOS_AUTHKIT_DOMAIN` + `WORKOS_M2M_CLIENT_ID` are non-secret `vars`;
the caller's client id/secret live with the caller, never in the worker.

## Why no AI when driven over MCP

`generate_description` runs **only** in the autonomous queue/app-surface path —
where the FundiAgent processes a task with no human/LLM in the loop. When a
platform-team LLM drives Fundi over MCP, that LLM is already the intelligence;
Fundi does not run a second model to write prose. The description model is
**Workers AI (Kimi `@cf/moonshotai/kimi-k2.6` by default)**, routed through the
**shamwari** AI Gateway for cost control + observability. Override with
`FUNDI_AI_MODEL` (e.g. a Qwen id) / `FUNDI_AI_GATEWAY`.

## How the sources all enqueue the same task

- **search-miss** — a user searches a place that doesn't exist → call
  `seed_region` (or `POST /tasks`) and return to the user immediately
  ("this place will exist going forward"). Never block the read.
- **app empty-state** — e.g. a surface in Mali shows nothing → "find places in
  Mali?" → tap calls `seed_region` with `source.surface`.
- **ops/MCP bulk** — `seed_admin_bulk` (or `POST /tasks` with `{ "intent": … }`)
  runs a **generator** that fans one intent into N atomic `point_radius` tasks.

## Native driver vs Atlas Data API

**Decision: the official `mongodb` Node driver.** It runs on Workers under
`nodejs_compat`, opening TCP sockets _inside_ request/queue handlers — exactly
the path the production sibling `mongodb-mcp` worker already uses. This gives us
real BSON typing (`Double` for score/rating fields, ints for counts — never
`$number*` Extended JSON wrappers, per §7), the full query/upsert surface for
idempotent writes, and one consistent access path across both workers. The Atlas
Data API was therefore not needed; if a future runtime constraint forces it, the
endpoint would be resolved from the provider registry like any other source.

> The driver must only connect inside a handler (never at module scope).
> `FundiAgent.getMongo()` enforces this and caches the client across retries.

## Deploy

```sh
npm install

# 1. Create the D1 ledger (its id is written into fundi/wrangler.jsonc)
npx wrangler d1 create fundi-ingestion-ledger
npx wrangler d1 migrations apply fundi-ingestion-ledger --remote -c fundi/wrangler.jsonc

# 2. Create the dedupe KV namespace
npx wrangler kv namespace create DEDUP_KV

# 3. Create the queues
npx wrangler queues create fundi-ingestion-tasks
npx wrangler queues create fundi-ingestion-tasks-dlq

# 4. Set the M2M gate vars (non-secret) in fundi/wrangler.jsonc:
#      WORKOS_AUTHKIT_DOMAIN  = https://<your-env>.authkit.app
#      WORKOS_M2M_CLIENT_ID   = client_… (the Fundi M2M application id = aud)
#    Secrets (never inlined). generate_description uses the Workers AI binding,
#    so there is no LLM API key to set.
npx wrangler secret put MONGODB_URI        -c fundi/wrangler.jsonc
npx wrangler secret put WHAT3WORDS_API_KEY -c fundi/wrangler.jsonc   # optional

# 5. Deploy
npm run deploy:fundi
```

> The deploying Cloudflare API token needs **Workers Scripts: Edit**, **D1: Edit**,
> **Workers KV Storage: Edit**, **Queues: Edit**, **Workers AI: Read**, and — for the
> `fundi-ingestion.nyuchi.dev` custom domain — **Zone › Workers Routes: Edit** and
> **Zone › DNS: Edit** on the `nyuchi.dev` zone.
>
> WorkOS: create a **M2M application** (this is the `aud`); issue a credential
> (client id/secret) to each caller. No redirect URI is needed for M2M.

## Run a first task

Local dev:

```sh
cp fundi/.dev.vars.example fundi/.dev.vars   # fill in MONGODB_URI etc.
npm run dev:fundi                            # http://localhost:8789

curl -s -X POST http://localhost:8789/tasks \
  -H 'content-type: application/json' \
  --data @fundi/examples/point_radius.harare.json
```

Bulk (ops):

```sh
curl -s -X POST http://localhost:8789/tasks -H 'content-type: application/json' \
  -d '{"intent":"african_capitals","radiusMeters":20000}'
```

See [`examples/expected-output.md`](examples/expected-output.md) for the tier-0
place/entity records this produces.

## Develop

```sh
npm run type-check:fundi   # tsc --noEmit -p fundi/tsconfig.json
npm run test:fundi         # vitest (pure-logic skills, Node env)
```

## Out of scope (do not build now)

Relational/landmark wayfinding; the verification journey / tier-raising; the old
Supabase establishment seed; what3words at read time. Room is left in the schema
(`bundu.communityCaretakers`, `hierarchy`, the `routes` collection) for the
future relational layer — used as it exists today, innovated on later.

# Security Policy

## Supported versions

Only the currently deployed revision of `mongodb-mcp` — the `main` branch,
served at `https://mongodb.nyuchi.dev/mcp` — is supported. Cloudflare Workers
rollouts atomically replace older revisions, so there are no back-versions to
patch.

## Reporting a vulnerability

If you believe you've found a security vulnerability — particularly anything
that could

- bypass the WorkOS OAuth gate on `/mcp` (Authorization Code + PKCE against
  the Connect application),
- get a session outside the `WORKOS_ALLOWED_ORG_IDS` allowlist, or without the
  required `mongodb:access` permission in its granted scope, accepted into the
  MCP tool surface,
- reach user or role administration through the server — no tool exposes it and
  `runCommand` refuses the command family, so any path that creates a user,
  grants a role, or otherwise needs `userAdmin` is a privilege-escalation bug,
- defeat a `confirm` gate on an irreversible tool (`dropCollection`,
  `dropDatabase`, `dropIndexes`, `convertToCapped`, `enableSharding`,
  `shardCollection`, or `deleteMany` with an empty filter),
- leak `MONGODB_URI` or `COOKIE_ENCRYPTION_KEY`,
- or trigger arbitrary writes / drops on connected MongoDB clusters via the
  MCP tools —

**please email `security@nyuchi.com`** rather than opening a public issue.
We aim to acknowledge within two business days and to ship a fix or
mitigation for high-severity issues within thirty days.

Please include:

- a description of the issue and the impact you observed,
- a minimal reproduction or proof of concept,
- the WorkOS organization id you were operating under (if relevant), and
- whether you have disclosed the issue to anyone else yet.

We don't currently run a paid bug-bounty programme, but we will credit
reporters in release notes unless you prefer to remain anonymous.

## Scope

In scope:

- the deployed worker at `https://mongodb.nyuchi.dev/*`,
- the source in this repository,
- the WorkOS OAuth flow and org/permission gate in `src/authkit-handler.ts`,
  the `OAuthProvider` wiring in `src/index.ts`, and the client-approval cookie
  helpers in `src/workers-oauth-utils.ts`,
- the tool guards in `src/tools.ts`: `assertNotIdentityCommand`, the `confirm`
  gates, and the 256 KiB response cap in `src/ejson.ts`.

Out of scope:

- vulnerabilities in upstream dependencies (`mongodb`, `agents`,
  `@modelcontextprotocol/sdk`, `@modelcontextprotocol/server`, `jose`, `zod`) —
  please report those upstream and we'll roll the patched release;
- the MCP tools doing what an authorized caller asked with the privileges the
  `MONGODB_URI` credential holds. Scope that credential to the least role that
  covers your usage (see the README's role table); it must never hold
  `userAdmin`, `userAdminAnyDatabase`, or `root`;
- social engineering of Nyuchi staff or contractors;
- denial-of-service against Cloudflare or WorkOS infrastructure;
- findings from automated scanners without a working proof of concept.

## Coordinated disclosure

We follow a 90-day coordinated-disclosure window by default. If we ship a
fix earlier, public disclosure can happen as soon as the fix is deployed.
If we need longer (e.g. to roll a backwards-incompatible change through
dependent services), we'll let you know and agree an extended timeline.

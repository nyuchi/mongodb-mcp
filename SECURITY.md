# Security Policy

## Supported versions

Only the currently deployed revision of `mongodb-mcp` — the `main` branch,
served at `https://mongodb.nyuchi.dev/mcp` — is supported. Cloudflare Workers
rollouts atomically replace older revisions, so there are no back-versions to
patch.

## Reporting a vulnerability

If you believe you've found a security vulnerability — particularly anything
that could

- bypass the WorkOS M2M (`client_credentials`) gate on `/mcp`,
- get a token outside the configured audience or `org_id` allowlist accepted
  into the MCP tool surface,
- leak `MONGODB_URI`,
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
- the WorkOS M2M JWT verification in `src/m2m-auth.ts` and the gate that
  enforces it in `src/index.ts`.

Out of scope:

- vulnerabilities in upstream dependencies (`mongodb`, `agents`,
  `@modelcontextprotocol/sdk`, `jose`, `zod`) — please report those upstream
  and we'll roll the patched release;
- social engineering of Nyuchi staff or contractors;
- denial-of-service against Cloudflare or WorkOS infrastructure;
- findings from automated scanners without a working proof of concept.

## Coordinated disclosure

We follow a 90-day coordinated-disclosure window by default. If we ship a
fix earlier, public disclosure can happen as soon as the fix is deployed.
If we need longer (e.g. to roll a backwards-incompatible change through
dependent services), we'll let you know and agree an extended timeline.

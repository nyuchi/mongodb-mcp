// Fundi worker entrypoint.
//   • /mcp     — OAuth-gated (WorkOS Authorization Code + PKCE) MCP surface.
//   • /tasks   — M2M-gated (WorkOS client_credentials) for agent callers.
//   • fetch    — composed: /tasks is intercepted before the OAuth provider.
//   • queue    — the consumer: routes each task to a durable FundiAgent (RPC).
//   • scheduled — a sweeper that re-enqueues tasks the agent's retries missed.
// FundiMcp and FundiAgent are Cloudflare Agents (Durable Objects); see mcp.ts / agent-do.ts.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { getAgentByName } from "agents";
import { z } from "zod";
import { BoundaryGuardError } from "./africa";
import { FundiAuthkitHandler } from "./authkit-handler";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { denyResponse, m2mConfig, verifyM2M } from "./m2m-auth";
import { bulkIntentSchema, seedTaskInputSchema, type SeedTask } from "./types";
import { FundiMcp } from "./mcp";
import { FundiAgent } from "./agent-do";
import { listRequeuable, markStatus } from "./ledger";

export { FundiAgent, FundiMcp };

// /tasks is the surface fundi agents call, so it is gated by the *fundi agents*
// M2M app (WORKOS_AGENTS_M2M_CLIENT_ID), distinct from /mcp which uses OAuth.
// Falls back to the internal MCP M2M app until the agents app is configured,
// and also accepts the optional static FUNDI_API_TOKEN.
async function requireTaskAuth(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get("authorization") ?? "";
  if (env.FUNDI_API_TOKEN && header === `Bearer ${env.FUNDI_API_TOKEN}`) return null;
  const audience = env.WORKOS_AGENTS_M2M_CLIENT_ID || env.WORKOS_M2M_CLIENT_ID;
  const cfg = m2mConfig(env, audience);
  if (!cfg) return denyResponse(503, "auth not configured");
  const result = await verifyM2M(request, cfg);
  if (!result.ok) return denyResponse(result.status ?? 401, result.error ?? "unauthorized");
  return null;
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  try {
    if (body && typeof body === "object" && "intent" in body) {
      const intent = bulkIntentSchema.parse(body);
      const outcomes = await submitBulkIntent(env, intent);
      return json({
        kind: "bulk",
        tasksCreated: outcomes.filter((o) => !o.deduped).length,
        deduped: outcomes.filter((o) => o.deduped).length,
        taskIds: outcomes.map((o) => o.taskId),
      });
    }
    const input = seedTaskInputSchema.parse(body);
    const outcome = await submitSeedTask(env, input);
    return json(
      { kind: "seed", ...outcome, message: "This region will exist going forward." },
      202,
    );
  } catch (e) {
    if (e instanceof z.ZodError) {
      return json({ error: "invalid request body", issues: e.issues }, 400);
    }
    if (e instanceof BoundaryGuardError) {
      return json({ error: "region is outside the ingestion boundary" }, 422);
    }
    console.error("submit failed", { error: e instanceof Error ? e.message : String(e) });
    return json({ error: "could not process task" }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// /mcp is gated by WorkOS OAuth (Authorization Code + PKCE). MCP clients
// (Claude.ai web, Cursor, Codex, mcp-remote, etc.) sign in via WorkOS.
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: FundiMcp.serve("/mcp") as never,
  defaultHandler: FundiAuthkitHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // /tasks remains M2M-gated so agents can call it without browser sign-in.
    if (url.pathname === "/tasks" && request.method === "POST") {
      const denied = await requireTaskAuth(request, env);
      if (denied) return denied;
      return handleSubmit(request, env);
    }

    // Everything else (/mcp, /authorize, /token, /register, /, /health, /callback)
    // flows through the OAuth provider.
    return oauthProvider.fetch(request, env, ctx);
  },

  // Queue consumer: hand each task to its durable agent.
  async queue(batch: MessageBatch<SeedTask>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const task = message.body;
      try {
        const agent = await getAgentByName<Env, FundiAgent>(env.FUNDI_AGENT, task.taskId);
        await agent.run(task);
        message.ack();
      } catch (e) {
        console.error("queue.consume failed", { taskId: task.taskId, error: String(e) });
        message.retry();
      }
    }
  },

  // Cron sweeper: re-enqueue tasks the agent's retries missed.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const tasks = await listRequeuable(env, 50);
        for (const task of tasks) {
          await markStatus(env, task.taskId, "queued");
          await env.TASK_QUEUE.send(task);
        }
        console.log(
          JSON.stringify({ worker: "fundi", event: "sweep.done", requeued: tasks.length }),
        );
      })(),
    );
  },
};

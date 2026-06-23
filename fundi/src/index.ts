// Fundi worker entrypoint. /mcp and /tasks are internal, platform-team-only
// surfaces gated by WorkOS M2M (client_credentials) — callers present a
// short-lived WorkOS JWT as `Authorization: Bearer`, which we verify statelessly
// (see m2m-auth.ts). No OAuth redirect, no session KV.
//   • fetch     — /mcp (M2M-gated MCP) + /tasks (M2M or FUNDI_API_TOKEN) + /health + /.
//   • queue     — the consumer: routes each task to a durable FundiAgent (RPC).
//   • scheduled — a sweeper that re-enqueues tasks the agent's retries missed.
// The agent + MCP are Cloudflare Agents (Durable Objects); see agent-do.ts / mcp.ts.

import { getAgentByName } from "agents";
import { z } from "zod";
import { BoundaryGuardError } from "./africa";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { landingHtml } from "./landing";
import { listRequeuable, markStatus } from "./ledger";
import { denyResponse, m2mConfig, verifyM2M } from "./m2m-auth";
import { bulkIntentSchema, seedTaskInputSchema, type SeedTask } from "./types";
import { FundiMcp } from "./mcp";
import { FundiAgent } from "./agent-do";

export { FundiAgent, FundiMcp };

const mcpHandler = FundiMcp.serve("/mcp");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// WorkOS M2M gate. Fails closed: if the worker has no M2M config, deny.
// `audienceCsv` selects which M2M application's tokens are accepted.
async function requireM2M(
  request: Request,
  env: Env,
  audienceCsv?: string,
): Promise<Response | null> {
  const cfg = m2mConfig(env, audienceCsv);
  if (!cfg) return denyResponse(503, "auth not configured");
  const result = await verifyM2M(request, cfg);
  if (!result.ok) return denyResponse(result.status ?? 401, result.error ?? "unauthorized");
  return null;
}

// /tasks is the surface fundi agents call, so it is gated by the *fundi agents*
// M2M app (WORKOS_AGENTS_M2M_CLIENT_ID), distinct from the internal MCP app that
// guards /mcp. Falls back to the internal MCP app until the agents app is
// configured, and also accepts the optional static FUNDI_API_TOKEN.
async function requireTaskAuth(request: Request, env: Env): Promise<Response | null> {
  const header = request.headers.get("authorization") ?? "";
  if (env.FUNDI_API_TOKEN && header === `Bearer ${env.FUNDI_API_TOKEN}`) return null;
  const audience = env.WORKOS_AGENTS_M2M_CLIENT_ID || env.WORKOS_M2M_CLIENT_ID;
  return requireM2M(request, env, audience);
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  try {
    // A bulk intent and an atomic task are both accepted here; bulk runs the
    // generator and enqueues many (§3, §5).
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
    // Never block the caller: return the task id immediately (§2).
    return json(
      { kind: "seed", ...outcome, message: "This region will exist going forward." },
      202,
    );
  } catch (e) {
    // Never echo raw exception text to the caller (CodeQL: info exposure via
    // stack trace). Surface only safe, intentional messages; log the rest.
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const denied = await requireM2M(request, env);
      if (denied) return denied;
      return mcpHandler.fetch(request, env, ctx);
    }
    if (url.pathname === "/tasks" && request.method === "POST") {
      const denied = await requireTaskAuth(request, env);
      if (denied) return denied;
      return handleSubmit(request, env);
    }
    if (url.pathname === "/health") {
      return json({ worker: "fundi-ingestion", status: "ok" });
    }
    if (url.pathname === "/") {
      return new Response(landingHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    return json({ error: "not found" }, 404);
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

  // Cron sweeper (optional, §3): re-enqueue stragglers the agent retries missed.
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

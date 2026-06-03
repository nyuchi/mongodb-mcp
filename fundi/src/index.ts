// Fundi worker entrypoint. Three faces of one engine:
//   • fetch        — the MCP surface (/mcp) and the POST /tasks submit endpoint.
//   • queue        — the consumer: routes each task to a durable FundiAgent (RPC).
//   • scheduled    — a light sweeper that re-enqueues tasks the agent's own
//                    retries could not resolve.
// The agent + MCP are Cloudflare Agents (Durable Objects); see agent-do.ts / mcp.ts.

import { getAgentByName } from "agents";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { listRequeuable, markStatus } from "./ledger";
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

function authorized(request: Request, env: Env): boolean {
  const expected = env.FUNDI_API_TOKEN;
  if (!expected) return true; // open if no token configured
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

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
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 400);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }
    if (url.pathname === "/tasks" && request.method === "POST") {
      return handleSubmit(request, env);
    }
    if (url.pathname === "/health" || url.pathname === "/") {
      return json({ worker: "fundi", status: "ok" });
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

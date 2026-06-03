// Fundi's MCP surface (§5), built on the Agents SDK's McpAgent (a Durable
// Object). Everything in the ecosystem is MCP: the search box, apps, and
// ops/you-via-an-MCP-client all invoke Fundi the same way. seed_region and the
// POST /tasks endpoint are two faces of the same enqueue path.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { submitBulkIntent, submitSeedTask } from "./enqueue";
import { getTaskStatus } from "./ledger";
import { encodePlusCode } from "./pluscode";
import { overpassLookup } from "./skills/overpass";
import { bulkIntentSchema, categoriesSchema, regionSchema, sourceSchema } from "./types";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

export class FundiMcp extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({
    name: "fundi",
    title: "Fundi — place ingestion",
    version: "0.1.0",
    description:
      "Agentic ingestion worker. Turns regions into clean, sovereign, tier-0 place and entity records.",
    websiteUrl: "https://fundi.nyuchi.dev",
  });

  async init() {
    this.server.tool(
      "seed_region",
      "Enqueue a seed task for a region. The main entry point — what a search-miss or app empty-state calls. Returns immediately with a task id; ingestion runs asynchronously.",
      { region: regionSchema, categories: categoriesSchema.optional(), source: sourceSchema },
      async ({ region, categories, source }) => {
        try {
          const outcome = await submitSeedTask(this.env, {
            region,
            categories: categories ?? "all",
            source,
          });
          return ok({ ...outcome, message: "This region will exist going forward." });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "seed_admin_bulk",
      "Run a bulk generator (e.g. all African capitals, 20km radius). Fans one intent out into many atomic region tasks.",
      { intent: bulkIntentSchema },
      async ({ intent }) => {
        try {
          const outcomes = await submitBulkIntent(this.env, intent);
          return ok({
            tasksCreated: outcomes.filter((o) => !o.deduped).length,
            deduped: outcomes.filter((o) => o.deduped).length,
            taskIds: outcomes.map((o) => o.taskId),
          });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "task_status",
      "Look up a task in the ledger by id.",
      { taskId: z.string().min(1) },
      async ({ taskId }) => {
        try {
          const row = await getTaskStatus(this.env, taskId);
          return row ? ok(row) : fail(new Error(`task not found: ${taskId}`));
        } catch (e) {
          return fail(e);
        }
      },
    );

    // ---- skills exposed for direct invocation / testing (§5) ----

    this.server.tool(
      "compute_pluscode",
      "Compute an Open Location Code (Plus Code) from lat/lng, locally — no API, no key.",
      { lat: z.number(), lng: z.number(), codeLength: z.number().int().min(2).max(15).optional() },
      async ({ lat, lng, codeLength }) => {
        try {
          return ok({ plusCode: encodePlusCode(lat, lng, codeLength ?? 10) });
        } catch (e) {
          return fail(e);
        }
      },
    );

    this.server.tool(
      "overpass_lookup",
      "Query OSM/Overpass for features in a bbox by category (read-only; does not write records).",
      {
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).describe("[s, w, n, e]"),
        categories: categoriesSchema.optional(),
        endpoint: z.string().url().optional(),
      },
      async ({ bbox, categories, endpoint }) => {
        try {
          const [s, w, n, e] = bbox;
          const features = await overpassLookup(
            { endpoint: endpoint ?? "https://overpass-api.de/api/interpreter" },
            { s, w, n, e },
            categories ?? "all",
          );
          return ok({ count: features.length, features: features.slice(0, 50) });
        } catch (e) {
          return fail(e);
        }
      },
    );
  }
}

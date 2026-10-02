import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { RelayCall } from "../relay-client";
import { MUTATE, READ, confirmArg, fail, limitArg, toolDefiner, type ToolResult } from "./common";

// Tools for the stores on Fly's private network. Every handler is one relay
// call; the relay (relay/src/ops.ts) owns the drivers and repeats the scope
// check. Op names here and there must match — test/private.test.ts and
// relay/test/ops.test.ts both pin the list.

// Apache Doris MCP 1.0 exposes eight stable domain tools in its default
// "hierarchical" mode. Call one with {} to discover its children, then again
// with child_tool + arguments + the manifest_version discovery returned. The
// built-in 1.0 catalogue is read-only (doris_admin is reserved and not
// registered), so all eight need only doris:access.
export const DORIS_DOMAINS = {
  doris_catalog: "Catalogs, databases, tables, table context and size.",
  doris_query: "Read-only SQL, EXPLAIN, query profiles, diagnosis and slow queries.",
  doris_cluster: "Nodes, tasks, metrics, memory, cache, compaction and workloads.",
  doris_pipeline: "Ingestion, materialised views, freshness and dependencies.",
  doris_search: "Text, vector and hybrid search, analysers and indexes.",
  doris_governance: "Data quality, storage, lineage, audit, UDFs and auth mapping.",
  doris_lakehouse: "External catalogs, lakehouse tables and Variant.",
  doris_semantic: "Optional semantic-layer grounding (Ossie, MetricFlow).",
} as const;

export const CASSANDRA_OPS = ["listKeyspaces", "listTables", "describeTable", "select", "execute"];
export const GRAPH_OPS = ["summary", "findVertices", "neighbours", "gremlin"];

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export function registerDorisTools(server: McpServer, relay: RelayCall): void {
  for (const [name, summary] of Object.entries(DORIS_DOMAINS)) {
    server.registerTool(
      name,
      {
        title: name.replace("doris_", "Doris ").replace(/_/g, " "),
        description: `${summary} Served by Apache Doris MCP through the private relay. Call with {} to discover children, then with child_tool, arguments and manifest_version.`,
        inputSchema: z.object({
          child_tool: z.string().min(1).optional().describe("Exact child name from discovery."),
          arguments: z.record(z.string(), z.unknown()).optional().describe("Child arguments."),
          manifest_version: z.string().min(1).optional().describe("From the discovery call."),
        }),
        annotations: { ...READ, openWorldHint: false },
      },
      (async (input: Record<string, unknown>) => {
        try {
          // Doris MCP already shapes its answer as an MCP tool result, so it
          // passes through unchanged rather than being re-wrapped as JSON text.
          const result = await relay("doris", "callTool", {
            tool: name,
            input,
          });
          if (isToolResult(result)) return result;
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (e) {
          return fail(e);
        }
      }) as never,
    );
  }
}

const keyspaceArg = { keyspace: z.string().min(1).describe("Keyspace name.") };
const cqlParams = {
  params: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default([])
    .describe("Positional values for ? markers."),
};

export function registerCassandraTools(server: McpServer, relay: RelayCall): void {
  const tool = toolDefiner(server);
  const call = (op: string, args: unknown) => relay("cassandra", op, args);

  tool(
    "listKeyspaces",
    "List Cassandra keyspaces with their replication settings.",
    {},
    { ...READ, title: "List keyspaces" },
    async () => call("listKeyspaces", {}),
  );
  tool(
    "listTables",
    "List the tables in a Cassandra keyspace.",
    { ...keyspaceArg },
    { ...READ, title: "List tables" },
    async (args) => call("listTables", args),
  );
  tool(
    "describeTable",
    "Describe a Cassandra table: columns, kinds (partition key, clustering, regular) and types.",
    { ...keyspaceArg, table: z.string().min(1).describe("Table name.") },
    { ...READ, title: "Describe table" },
    async (args) => call("describeTable", args),
  );
  tool(
    "select",
    "Run one CQL SELECT as the read-only role. Results are capped at `limit` rows.",
    {
      cql: z.string().min(1).describe("One CQL SELECT statement."),
      ...cqlParams,
      ...limitArg,
    },
    { ...READ, title: "CQL select" },
    async (args) => call("select", args),
  );
  tool(
    "execute",
    "Run one CQL statement that changes data (INSERT, UPDATE, DELETE). Needs cassandra:write, and the relay must have writes enabled for Cassandra.",
    {
      cql: z.string().min(1).describe("One CQL statement."),
      ...cqlParams,
      ...confirmArg,
    },
    { ...MUTATE, title: "CQL execute (write)" },
    async (args) => call("execute", args),
  );
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);

export function registerGraphTools(server: McpServer, relay: RelayCall): void {
  const tool = toolDefiner(server);
  const call = (op: string, args: unknown) => relay("graph", op, args);

  tool(
    "summary",
    "Count vertices and edges in the JanusGraph platform graph, grouped by label.",
    {},
    { ...READ, title: "Graph summary" },
    async () => call("summary", {}),
  );
  tool(
    "findVertices",
    "Find vertices by label and exact property values, returning their properties.",
    {
      label: z.string().min(1).optional().describe("Vertex label, e.g. Person or Organization."),
      has: z.record(z.string(), scalar).default({}).describe("Exact property matches."),
      ...limitArg,
    },
    { ...READ, title: "Find vertices" },
    async (args) => call("findVertices", args),
  );
  tool(
    "neighbours",
    "List a vertex's neighbours along edges, optionally of one label and direction.",
    {
      vertexId: z.union([z.string(), z.number()]).describe("Vertex id."),
      direction: z.enum(["out", "in", "both"]).default("both"),
      edgeLabel: z.string().min(1).optional().describe("Edge label, e.g. memberOf."),
      ...limitArg,
    },
    { ...READ, title: "Vertex neighbours" },
    async (args) => call("neighbours", args),
  );
  tool(
    "gremlin",
    "Evaluate a raw Gremlin script. A script can do anything the Gremlin user can, so this needs graph:write, and the relay must have writes enabled for the graph.",
    {
      script: z.string().min(1).describe("Gremlin (Groovy) script."),
      bindings: z.record(z.string(), scalar).default({}).describe("Script bindings."),
      ...confirmArg,
    },
    { ...MUTATE, title: "Gremlin script (write)" },
    async (args) => call("gremlin", args),
  );
}

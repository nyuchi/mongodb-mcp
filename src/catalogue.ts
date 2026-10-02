import { McpServer } from "@modelcontextprotocol/server";
import type { MongoClient } from "mongodb";
import type { AuditSink } from "./audit";
import type { Caller } from "./props";
import { ToolRegistry } from "./registry";
import type { RelayCall } from "./relay-client";
import { registerCassandraTools, registerDorisTools, registerGraphTools } from "./stores/private";
import { registerSupabaseTools, type SqlRunner } from "./stores/supabase";
import { registerMongoTools } from "./tools";

export const SERVER_NAME = "nyuchi-data-mcp";
export const SERVER_VERSION = "0.2.0";

// Everything a request's tools need, injected so tests can build the full
// catalogue without a driver, a socket or a relay.
export interface Backends {
  mongoRead: () => Promise<MongoClient>;
  mongoWrite: () => Promise<MongoClient>;
  sql: SqlRunner;
  relay: RelayCall;
}

// The full catalogue, before any permission is applied. MongoDB's tool set is
// registered twice — once over the read-only credential keeping only the
// read-only tools, once over the read-write credential keeping only the rest —
// so no read ever runs with a credential that could write.
export function buildRegistry(backends: Backends): ToolRegistry {
  const registry = new ToolRegistry();
  registerMongoTools(registry.collector("mongodb", "read"), backends.mongoRead);
  registerMongoTools(registry.collector("mongodb", "write"), backends.mongoWrite);
  registerSupabaseTools(registry.collector("supabase"), backends.sql);
  registerDorisTools(registry.collector("doris"), backends.relay);
  registerCassandraTools(registry.collector("cassandra"), backends.relay);
  registerGraphTools(registry.collector("graph"), backends.relay);
  return registry;
}

export function buildServer(
  caller: Caller,
  backends: Backends,
  audit: AuditSink,
  origin = "https://data.nyuchi.dev",
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    title: "Nyuchi Data MCP",
    version: SERVER_VERSION,
    description:
      "Operator MCP for Nyuchi's data stores: MongoDB, Supabase, Apache Doris, Cassandra and JanusGraph. Read-only unless the caller holds a store's write permission.",
    websiteUrl: origin,
    icons: [{ src: `${origin}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }],
  });
  buildRegistry(backends).mount(server, caller, audit);
  return server;
}

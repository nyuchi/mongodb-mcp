import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { MongoClient } from "mongodb";
import { landingHtml } from "./landing";
import { denyResponse, m2mConfig, verifyM2M } from "./m2m-auth";
import { buildClient } from "./mongo";
import { registerMongoTools } from "./tools";

export class MongoMcp extends McpAgent<Env, unknown, Record<string, unknown>> {
  server = new McpServer({
    name: "mongodb-mcp",
    title: "MongoDB MCP",
    version: "0.1.0",
    description:
      "Authenticated remote Model Context Protocol server for managing MongoDB clusters.",
    websiteUrl: "https://mongodb.nyuchi.dev",
    icons: [{ src: "https://mongodb.nyuchi.dev/icon.png", mimeType: "image/png", sizes: ["any"] }],
  });

  // Cached per Durable Object instance. The DO sticks around across many
  // requests on a single MCP session, so reusing the client avoids handshake
  // cost on every tool call.
  private mongo?: MongoClient;
  private connecting?: Promise<MongoClient>;

  private async getClient(): Promise<MongoClient> {
    if (this.mongo) return this.mongo;
    if (this.connecting) return this.connecting;

    const uri = (this.env as Env).MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not configured on the worker.");

    this.connecting = (async () => {
      const client = buildClient(uri);
      await client.connect();
      this.mongo = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async init() {
    registerMongoTools(this.server, () => this.getClient());
  }

  // Best-effort cleanup when the DO is being evicted.
  async cleanup() {
    if (this.mongo) {
      try {
        await this.mongo.close();
      } catch (e) {
        console.error("Error closing MongoDB client", e);
      }
      this.mongo = undefined;
    }
  }
}

// The /mcp surface is gated by WorkOS M2M (client_credentials): callers present a
// short-lived WorkOS JWT as `Authorization: Bearer`, verified statelessly against
// the environment JWKS (see m2m-auth.ts). Internal, platform-team-only. Fails
// closed when unconfigured.
const mcpHandler = MongoMcp.serve("/mcp");

async function requireM2M(request: Request, env: Env): Promise<Response | null> {
  const cfg = m2mConfig(env);
  if (!cfg) return denyResponse(503, "auth not configured");
  const result = await verifyM2M(request, cfg);
  if (!result.ok) return denyResponse(result.status ?? 401, result.error ?? "unauthorized");
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      const denied = await requireM2M(request, env);
      if (denied) return denied;
      return mcpHandler.fetch(request, env, ctx);
    }
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ worker: "mongodb-mcp", status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/") {
      return new Response(landingHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};

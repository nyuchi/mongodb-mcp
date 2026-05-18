import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { MongoClient } from "mongodb";
import { AuthkitHandler } from "./authkit-handler";
import { buildClient } from "./mongo";
import type { Props } from "./props";
import { registerMongoTools } from "./tools";

export class MongoMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "MongoDB MCP",
    version: "0.1.0",
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

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: MongoMcp.serve("/mcp") as never,
  defaultHandler: AuthkitHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { MongoClient } from "mongodb";
import { AuthkitHandler } from "./authkit-handler";
import { buildClient } from "./mongo";
import { registerMongoTools } from "./tools";

// The worker is stateless: each /mcp request builds a fresh McpServer, so there
// is no Durable Object left to hold a connection. What does survive between
// requests is the isolate, so the MongoClient lives here instead and the
// driver's own pool rides along with it. The promise is created inside the
// request path — workerd refuses to open sockets at module scope — and cleared
// on failure so one bad connect does not poison the isolate for its lifetime.
let clientPromise: Promise<MongoClient> | undefined;

function getClient(uri: string): Promise<MongoClient> {
  clientPromise ??= (async () => {
    const client = buildClient(uri);
    await client.connect();
    return client;
  })().catch((e: unknown) => {
    clientPromise = undefined;
    throw e;
  });
  return clientPromise;
}

// Built once per isolate. The factory inside runs per request and hands that
// request its own McpServer, which is what makes the endpoint stateless.
let handler: ReturnType<typeof createMcpHandler> | undefined;

function getHandler(uri: string) {
  handler ??= createMcpHandler(
    () => {
      const server = new McpServer({
        name: "mongodb-mcp",
        title: "MongoDB MCP",
        version: "0.1.21",
        description:
          "Authenticated remote Model Context Protocol server for managing MongoDB clusters.",
        websiteUrl: "https://mongodb.nyuchi.dev",
        icons: [
          { src: "https://mongodb.nyuchi.dev/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
        ],
      });
      registerMongoTools(server, () => getClient(uri));
      return server;
    },
    { route: "/mcp" },
  );
  return handler;
}

const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const uri = env.MONGODB_URI;
    if (!uri) {
      return Promise.resolve(
        new Response("MONGODB_URI is not configured on the worker.", { status: 500 }),
      );
    }
    return getHandler(uri)(request, env, ctx);
  },
};

// /mcp is gated by WorkOS OAuth (Authorization Code + PKCE). MCP clients
// (Claude.ai web, Cursor, Codex, mcp-remote, etc.) sign in via WorkOS before
// any tool call. The OAuthProvider handles /authorize, /token, and /register;
// AuthkitHandler manages the WorkOS redirect + callback dance.
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpApiHandler as never,
  defaultHandler: AuthkitHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import type { MongoClient } from "mongodb";
import { consoleAuditSink } from "./audit";
import { AuthkitHandler } from "./authkit-handler";
import { buildServer } from "./catalogue";
import { buildClient } from "./mongo";
import { callerFromProps } from "./props";
import { relayCaller } from "./relay-client";
import { postgresRunner } from "./stores/postgres";

// The worker is stateless: each /mcp request builds a fresh McpServer. What
// survives between requests is the isolate, so MongoClients live here, one per
// connection string (read-only and read-write are separate users). Each is
// created inside the request path — workerd refuses sockets at module scope —
// and dropped on a failed connect so one bad attempt cannot poison the isolate.
const mongoClients = new Map<string, Promise<MongoClient>>();

function mongoClient(uri: string | undefined, secretName: string): Promise<MongoClient> {
  if (!uri) {
    return Promise.reject(new Error(`${secretName} is not configured on this worker.`));
  }
  let client = mongoClients.get(uri);
  if (!client) {
    client = (async () => {
      const c = buildClient(uri);
      await c.connect();
      return c;
    })();
    client.catch(() => mongoClients.delete(uri));
    mongoClients.set(uri, client);
  }
  return client;
}

// Built once per isolate. The factory runs per request inside the OAuth
// provider's auth context, so getMcpAuthContext() returns this caller's props
// and the server it builds carries only the tools their scopes allow.
let handler: ReturnType<typeof createMcpHandler> | undefined;

function getHandler(env: Env) {
  handler ??= createMcpHandler(
    () => {
      const caller = callerFromProps(getMcpAuthContext()?.props);
      return buildServer(
        caller,
        {
          mongoRead: () => mongoClient(env.MONGODB_RO_URI, "MONGODB_RO_URI"),
          mongoWrite: () => mongoClient(env.MONGODB_RW_URI, "MONGODB_RW_URI"),
          sql: postgresRunner(env as unknown as Record<string, unknown>),
          relay: relayCaller({ url: env.RELAY_URL, secret: env.RELAY_SIGNING_SECRET }, caller),
        },
        consoleAuditSink,
      );
    },
    { route: "/mcp" },
  );
  return handler;
}

const mcpApiHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getHandler(env)(request, env, ctx);
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

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import { registerMongoTools } from "../src/tools";

// Exercises the stateless path end to end inside workerd: a real SDK v2
// McpServer built per request by createMcpHandler, driven over HTTP the way an
// MCP client drives it. Registration alone (tools.test.ts) would not catch the
// handler failing to construct or the transport rejecting our tool shapes.
const handler = createMcpHandler(
  () => {
    const server = new McpServer({ name: "mongodb-mcp", version: "test" });
    registerMongoTools(server, () => Promise.reject<MongoClient>(new Error("no cluster in tests")));
    return server;
  },
  { route: "/mcp" },
);

const PROTOCOL_VERSION = "2025-06-18";

async function rpc(body: unknown): Promise<Record<string, unknown>> {
  const response = await handler.fetch(
    new Request("https://mongodb.nyuchi.dev/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);

  const text = await response.text();
  // Streamable HTTP answers as SSE (event:/data: frames) or as plain JSON
  // depending on the negotiated era; take the last data: frame when present.
  const frames = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  const payload = frames.length > 0 ? frames[frames.length - 1] : text;
  return JSON.parse(payload) as Record<string, unknown>;
}

describe("stateless MCP handler", () => {
  it("completes an initialize handshake", async () => {
    const result = (
      await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "vitest", version: "1" },
        },
      })
    ).result as { serverInfo?: { name?: string } };
    expect(result.serverInfo?.name).toBe("mongodb-mcp");
  });

  it("lists the full tool surface with no identity-management tools", async () => {
    const result = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }))
      .result as { tools: { name: string; annotations?: Record<string, unknown> }[] };

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("find");
    expect(names).toContain("connectionStatus");
    for (const forbidden of ["createUser", "dropUser", "createRole", "grantRolesToUser"]) {
      expect(names, `${forbidden} must not be served`).not.toContain(forbidden);
    }
    expect(names.length).toBe(64);
  });

  it("refuses an identity command sent through runCommand", async () => {
    const result = (
      await rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "runCommand",
          arguments: { db: "admin", command: { createUser: "mallory", roles: ["root"] } },
        },
      })
    ).result as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Refused");
  });

  it("serves each request from a fresh server instance", async () => {
    const first = (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }))
      .result as { tools: unknown[] };
    const second = (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }))
      .result as { tools: unknown[] };
    expect(first.tools.length).toBe(second.tools.length);
  });
});

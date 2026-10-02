import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dorisChildEnv, PROTOCOL_VERSION, StdioMcpClient } from "../src/doris.ts";

// A stand-in for doris-mcp-server: reads newline-delimited JSON-RPC on stdin,
// logs noise on stdout and stderr, and echoes back what it was asked.
const FAKE_SERVER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
console.log("not json, ignored");
console.error("log line");
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.params.name === "boom") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "boom" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(req) }] } }) + "\\n");
});
`;

describe("StdioMcpClient", () => {
  it("sends self-contained 2026-07-28 requests and matches replies by id", async () => {
    const client = new StdioMcpClient(
      process.execPath,
      ["-e", FAKE_SERVER],
      { PATH: process.env.PATH },
      5000,
    );
    try {
      const [a, b] = (await Promise.all([
        client.request("tools/call", { name: "doris_catalog", arguments: {} }),
        client.request("tools/call", {
          name: "doris_query",
          arguments: { child_tool: "execute_query" },
        }),
      ])) as { content: { text: string }[] }[];
      const sentA = JSON.parse(a.content[0].text);
      const sentB = JSON.parse(b.content[0].text);
      assert.equal(sentA.params.name, "doris_catalog");
      assert.equal(sentB.params.arguments.child_tool, "execute_query");
      assert.equal(sentA.params._meta["io.modelcontextprotocol/protocolVersion"], PROTOCOL_VERSION);
      await assert.rejects(client.request("tools/call", { name: "boom" }), /Doris MCP: boom/);
    } finally {
      client.close();
    }
  });

  it("fails pending calls when the child exits", async () => {
    const client = new StdioMcpClient(
      process.execPath,
      ["-e", "process.exit(3)"],
      { PATH: process.env.PATH },
      5000,
    );
    await assert.rejects(client.request("tools/call", { name: "x" }), /exited/);
  });
});

describe("dorisChildEnv", () => {
  it("passes Doris settings and nothing else of the relay's secrets", () => {
    const env = dorisChildEnv({
      PATH: "/bin",
      DORIS_MCP_RO_PASSWORD: "doris-pw",
      RELAY_SIGNING_SECRET: "never",
      CASSANDRA_MCP_RO_PASSWORD: "never",
      GREMLIN_PASSWORD: "never",
    });
    assert.equal(env.DORIS_PASSWORD, "doris-pw");
    assert.equal(env.TRANSPORT, "stdio");
    assert.equal(env.DORIS_HOST, "mukoko-doris.internal");
    assert.ok(!Object.values(env).includes("never"));
  });
});

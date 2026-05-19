import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import { fail, permissionHint, registerMongoTools } from "../src/tools";

type Registered = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
};

// Minimal stub that captures every server.tool() call. We don't need a real
// McpServer — only the surface registerMongoTools touches.
function makeFakeServer(): { server: McpServer; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, unknown>,
      handler: Registered["handler"],
    ) {
      tools.set(name, { name, description, schema, handler });
      return {} as unknown;
    },
  } as unknown as McpServer;
  return { server, tools };
}

function fakeGetClient(): Promise<MongoClient> {
  // Tools that touch the client should never run in these tests.
  return Promise.reject(new Error("fakeGetClient should not be invoked"));
}

describe("permissionHint", () => {
  it("returns null for non-error inputs", () => {
    expect(permissionHint(null)).toBeNull();
    expect(permissionHint(undefined)).toBeNull();
    expect(permissionHint("oops")).toBeNull();
    expect(permissionHint(42)).toBeNull();
  });

  it("returns null for unrelated errors", () => {
    expect(permissionHint(new Error("connection refused"))).toBeNull();
    expect(permissionHint({ code: 11000, codeName: "DuplicateKey" })).toBeNull();
  });

  it("hints at Unauthorized (code 13) with a role-grant recommendation", () => {
    const hint = permissionHint({ code: 13, codeName: "Unauthorized" });
    expect(hint).toContain("Unauthorized");
    expect(hint).toContain("readWrite");
    expect(hint).toContain("dbAdmin");
    expect(hint).toContain("MongoDB user role requirements");
  });

  it("hints at AuthenticationFailed (code 18) with a credentials check", () => {
    const hint = permissionHint({ code: 18, codeName: "AuthenticationFailed" });
    expect(hint).toContain("AuthenticationFailed");
    expect(hint).toContain("MONGODB_URI");
    expect(hint).toContain("authSource");
  });

  it("matches by codeName even when code is missing", () => {
    expect(permissionHint({ codeName: "Unauthorized" })).toContain("Unauthorized");
  });

  it("matches by message substring as a last resort", () => {
    const hint = permissionHint(new Error("not authorized on app to execute command find"));
    expect(hint).toContain("Unauthorized");
  });

  it("recognises RoleNotFound and UserNotFound as auth-shaped failures", () => {
    expect(permissionHint({ code: 31, codeName: "RoleNotFound" })).not.toBeNull();
    expect(permissionHint({ code: 33, codeName: "UserNotFound" })).not.toBeNull();
  });
});

describe("fail()", () => {
  it("formats an Error as 'Name: message'", () => {
    const result = fail(new TypeError("bad arg"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TypeError: bad arg");
  });

  it("stringifies non-Error throws", () => {
    const result = fail("string failure");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("string failure");
  });

  it("appends a permission hint when the error looks auth-shaped", () => {
    const err = Object.assign(new Error("not authorized on admin to execute"), {
      code: 13,
      codeName: "Unauthorized",
    });
    const result = fail(err);
    expect(result.content[0].text).toContain("Error: not authorized on admin to execute");
    expect(result.content[0].text).toContain("MongoDB user role requirements");
  });

  it("omits the hint for non-auth errors", () => {
    const result = fail(new Error("duplicate key"));
    expect(result.content[0].text).toBe("Error: duplicate key");
    expect(result.content[0].text).not.toContain("readWrite");
  });
});

describe("registerMongoTools", () => {
  const { server, tools } = makeFakeServer();
  registerMongoTools(server, fakeGetClient);

  it("registers every public tool", () => {
    const expected = [
      // discovery
      "listDatabases",
      "listCollections",
      "dbStats",
      "collStats",
      "ping",
      // reads
      "find",
      "findOne",
      "count",
      "aggregate",
      "distinct",
      "estimatedDocumentCount",
      "explain",
      // writes
      "insertOne",
      "insertMany",
      "updateOne",
      "updateMany",
      "deleteOne",
      "deleteMany",
      "replaceOne",
      "findOneAndUpdate",
      "findOneAndReplace",
      "findOneAndDelete",
      "bulkWrite",
      // admin / DDL
      "createCollection",
      "dropCollection",
      "renameCollection",
      "createView",
      "createIndex",
      "listIndexes",
      "dropIndex",
      "runCommand",
      // Atlas Search
      "listSearchIndexes",
      "createSearchIndex",
      "updateSearchIndex",
      "dropSearchIndex",
      // user management
      "createUser",
      "updateUser",
      "dropUser",
      "grantRolesToUser",
      "revokeRolesFromUser",
    ];
    for (const name of expected) {
      expect(tools.has(name), `expected tool '${name}' to be registered`).toBe(true);
    }
    expect(tools.size).toBe(expected.length);
  });

  it("gives every tool a non-empty human description", () => {
    for (const [name, t] of tools) {
      expect(t.description.length, `${name} description`).toBeGreaterThan(0);
    }
  });

  it("deleteMany refuses an empty filter without confirm:true", async () => {
    const deleteMany = tools.get("deleteMany");
    expect(deleteMany).toBeDefined();
    const result = await deleteMany!.handler({
      db: "app",
      collection: "users",
      filter: {},
      confirm: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Refusing to deleteMany with an empty filter");
  });

  it("deleteMany refuses a missing filter when confirm is false", async () => {
    const deleteMany = tools.get("deleteMany");
    const result = await deleteMany!.handler({
      db: "app",
      collection: "users",
      filter: undefined as unknown as Record<string, unknown>,
      confirm: false,
    });
    expect(result.isError).toBe(true);
  });
});

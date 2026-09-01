import type { McpServer } from "@modelcontextprotocol/server";
import type { MongoClient } from "mongodb";
import type { ZodObject, ZodRawShape } from "zod";
import { describe, expect, it } from "vitest";
import { assertNotIdentityCommand, fail, permissionHint, registerMongoTools } from "../src/tools";

type Registered = {
  name: string;
  title: string;
  description: string;
  shape: ZodRawShape;
  annotations: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }>;
};

// Minimal stub that captures every registerTool() call. We don't need a real
// McpServer — only the surface registerMongoTools touches. SDK v2 registers
// with (name, config, handler), the config carrying title, description,
// inputSchema and annotations.
function makeFakeServer(): { server: McpServer; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool(
      name: string,
      config: {
        title: string;
        description: string;
        inputSchema: ZodObject<ZodRawShape>;
        annotations: Record<string, unknown>;
      },
      handler: Registered["handler"],
    ) {
      tools.set(name, {
        name,
        title: config.title,
        description: config.description,
        shape: config.inputSchema.shape,
        annotations: config.annotations,
        handler,
      });
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

describe("assertNotIdentityCommand", () => {
  it("throws for user and role administration commands, whatever the casing", () => {
    for (const command of [
      { createUser: "x" },
      { dropAllUsersFromDatabase: 1 },
      { revokePrivilegesFromRole: "r", privileges: [] },
      { RolesInfo: 1 },
      { invalidateUserCache: 1 },
    ]) {
      expect(() => assertNotIdentityCommand(command), Object.keys(command)[0]).toThrow(/Refused/);
    }
  });

  it("rejects an identity command hidden behind another key", () => {
    expect(() => assertNotIdentityCommand({ ping: 1, createUser: "mallory" })).toThrow(/Refused/);
  });

  it("allows ordinary commands", () => {
    for (const command of [{ ping: 1 }, { collStats: "users" }, { find: "users", filter: {} }]) {
      expect(() => assertNotIdentityCommand(command)).not.toThrow();
    }
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
      "createIndexes",
      "listIndexes",
      "dropIndex",
      "dropIndexes",
      "hideIndex",
      "unhideIndex",
      "runCommand",
      // Atlas Search
      "listSearchIndexes",
      "createSearchIndex",
      "updateSearchIndex",
      "dropSearchIndex",
      // database admin
      "dropDatabase",
      "collMod",
      "validate",
      "dataSize",
      "dbHash",
      "convertToCapped",
      // monitoring
      "serverStatus",
      "hostInfo",
      "buildInfo",
      "connectionStatus",
      "listCommands",
      "getLog",
      "top",
      "connPoolStats",
      "currentOp",
      "killOp",
      // replication & sharding
      "replSetGetStatus",
      "listShards",
      "balancerStatus",
      "enableSharding",
      "shardCollection",
      // profiling
      "getProfilingStatus",
      "setProfilingLevel",
      "getProfilingData",
      "indexStats",
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

  it("gives every tool a title and behavioural annotations", () => {
    for (const [name, t] of tools) {
      expect(typeof t.title, `${name} title`).toBe("string");
      expect(t.title.length, `${name} title`).toBeGreaterThan(0);
      expect(typeof t.annotations.readOnlyHint, `${name} readOnlyHint`).toBe("boolean");
      expect(typeof t.annotations.destructiveHint, `${name} destructiveHint`).toBe("boolean");
    }
  });

  it("registers no identity-management tool", () => {
    const forbidden = [
      "createUser",
      "updateUser",
      "dropUser",
      "grantRolesToUser",
      "revokeRolesFromUser",
      "listUsers",
      "listRoles",
      "createRole",
      "updateRole",
      "dropRole",
      "grantRolesToRole",
      "revokeRolesFromRole",
      "grantPrivilegesToRole",
      "revokePrivilegesFromRole",
    ];
    for (const name of forbidden) {
      expect(tools.has(name), `'${name}' needs userAdmin and must not be exposed`).toBe(false);
    }
  });

  it("runCommand refuses user and role administration commands", async () => {
    const runCommand = tools.get("runCommand");
    expect(runCommand).toBeDefined();
    for (const command of [
      { createUser: "mallory", pwd: "x", roles: ["root"] },
      { grantRolesToUser: "someone", roles: ["root"] },
      { CREATEROLE: "sneaky" },
      { usersInfo: 1 },
    ]) {
      const result = await runCommand!.handler({ db: "admin", command });
      expect(result.isError, `${Object.keys(command)[0]} should be refused`).toBe(true);
      expect(result.content[0].text).toContain("Refused");
    }
  });

  it("runCommand still allows ordinary commands through to the driver", async () => {
    // fakeGetClient rejects, so reaching it at all proves the guard let it past.
    const result = await tools.get("runCommand")!.handler({
      db: "admin",
      command: { ping: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("fakeGetClient should not be invoked");
  });

  it("gates every irreversible tool behind confirm: true", () => {
    const gated = [
      "dropCollection",
      "dropDatabase",
      "dropIndexes",
      "convertToCapped",
      "enableSharding",
      "shardCollection",
    ];
    for (const name of gated) {
      const confirm = tools.get(name)?.shape.confirm as
        | { safeParse: (value: unknown) => { success: boolean } }
        | undefined;
      expect(confirm, `${name} should take a confirm argument`).toBeDefined();
      expect(confirm!.safeParse(true).success, `${name} should accept confirm: true`).toBe(true);
      expect(confirm!.safeParse(false).success, `${name} should reject confirm: false`).toBe(false);
      expect(confirm!.safeParse(undefined).success, `${name} should require confirm`).toBe(false);
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

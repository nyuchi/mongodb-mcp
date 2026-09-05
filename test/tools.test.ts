import type { McpServer } from "@modelcontextprotocol/server";
import type { MongoClient } from "mongodb";
import type { ZodObject, ZodRawShape } from "zod";
import { describe, expect, it } from "vitest";
import {
  ADD,
  IDENTITY_COMMANDS,
  MUTATE,
  READ,
  assertNotIdentityCommand,
  fail,
  permissionHint,
  registerMongoTools,
} from "../src/tools";

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

  // Presence is not the property that matters. Clients auto-approve on
  // readOnlyHint, so a destructive tool wearing readOnlyHint: true is a way to
  // get an unattended drop past a human. These assertions are derived from the
  // tool's name and the exported presets rather than a list kept alongside the
  // registry, so a mislabelled tool fails even if someone updates both files.
  describe("annotations are correct, not merely present", () => {
    const safetyOf = (name: string) => {
      const a = tools.get(name)!.annotations;
      return { readOnly: a.readOnlyHint as boolean, destructive: a.destructiveHint as boolean };
    };

    it("uses only the three coherent safety shapes", () => {
      const shapes = [READ, ADD, MUTATE].map((p) => `${p.readOnlyHint}/${p.destructiveHint}`);
      for (const [name] of tools) {
        const { readOnly, destructive } = safetyOf(name);
        expect(shapes, `${name} has an off-preset safety shape`).toContain(
          `${readOnly}/${destructive}`,
        );
      }
    });

    it("never marks a tool both read-only and destructive", () => {
      for (const [name] of tools) {
        const { readOnly, destructive } = safetyOf(name);
        expect(readOnly && destructive, `${name} claims to be read-only and destructive`).toBe(
          false,
        );
      }
    });

    // Anything that reads: a client may run it unattended, so it must not be
    // able to change the cluster.
    it("marks every read-shaped tool read-only and non-destructive", () => {
      const readShaped = /^(list|get)|Stats$/;
      const alsoReads = [
        "find",
        "findOne",
        "count",
        "ping",
        "distinct",
        "estimatedDocumentCount",
        "explain",
        "validate",
        "dataSize",
        "dbHash",
        "serverStatus",
        "hostInfo",
        "buildInfo",
        "connectionStatus",
        "top",
        "currentOp",
        "replSetGetStatus",
        "balancerStatus",
      ];
      const names = [...tools.keys()].filter((n) => readShaped.test(n) || alsoReads.includes(n));
      expect(names.length).toBeGreaterThan(25);
      for (const name of names) {
        const { readOnly, destructive } = safetyOf(name);
        expect(readOnly, `${name} reads and must be readOnlyHint: true`).toBe(true);
        expect(destructive, `${name} reads and must not be destructiveHint: true`).toBe(false);
      }
    });

    // Anything that can overwrite or remove: the client must be told, so a
    // human sees a prompt before it runs.
    it("marks every mutating tool destructive and not read-only", () => {
      const mutating =
        /^(drop|delete|update|replace|findOneAnd|kill|shard|enableSharding|convertToCapped|collMod|rename|bulkWrite|hideIndex|setProfilingLevel|runCommand)/;
      const names = [...tools.keys()].filter((n) => mutating.test(n));
      expect(names.length).toBeGreaterThan(15);
      for (const name of names) {
        const { readOnly, destructive } = safetyOf(name);
        expect(destructive, `${name} mutates and must be destructiveHint: true`).toBe(true);
        expect(readOnly, `${name} mutates and must not be readOnlyHint: true`).toBe(false);
      }
    });

    it("never marks a writing tool read-only", () => {
      for (const name of [...tools.keys()].filter((n) => /^(insert|create|aggregate)/.test(n))) {
        expect(safetyOf(name).readOnly, `${name} writes and must not be readOnlyHint: true`).toBe(
          false,
        );
      }
    });

    it("treats read-only tools as idempotent", () => {
      for (const [name, t] of tools) {
        if (t.annotations.readOnlyHint) {
          expect(t.annotations.idempotentHint, `${name} is read-only but not idempotent`).toBe(
            true,
          );
        }
      }
    });

    // Every tool acts on the one connected cluster. runCommand is the sole
    // open-ended escape hatch, so it is the sole openWorldHint.
    it("reserves openWorldHint for runCommand", () => {
      const open = [...tools].filter(([, t]) => t.annotations.openWorldHint).map(([n]) => n);
      expect(open).toEqual(["runCommand"]);
    });
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

  // Driven from the exported set rather than a sample of it: adding a command
  // to IDENTITY_COMMANDS without it actually being refused fails here, and so
  // does quietly removing one.
  it("runCommand refuses every command in IDENTITY_COMMANDS", async () => {
    const runCommand = tools.get("runCommand");
    expect(runCommand).toBeDefined();
    expect(IDENTITY_COMMANDS.size).toBeGreaterThanOrEqual(17);

    for (const command of IDENTITY_COMMANDS) {
      for (const spelling of [
        command,
        command.toUpperCase(),
        command[0].toUpperCase() + command.slice(1),
      ]) {
        const result = await runCommand!.handler({ db: "admin", command: { [spelling]: 1 } });
        expect(result.isError, `runCommand should refuse '${spelling}'`).toBe(true);
        expect(result.content[0].text).toContain("Refused");
      }
    }
  });

  it("refuses an identity command smuggled in beside a benign one", async () => {
    const result = await tools.get("runCommand")!.handler({
      db: "admin",
      command: { ping: 1, listCollections: 1, createUser: "mallory", roles: ["root"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Refused");
  });

  // The set is the guard's whole surface area. Pin the entries that matter so
  // shrinking it is a visible, deliberate edit rather than a silent one.
  it("keeps every privilege-granting command in IDENTITY_COMMANDS", () => {
    for (const command of [
      "createuser",
      "updateuser",
      "dropuser",
      "dropallusersfromdatabase",
      "grantrolestouser",
      "revokerolesfromuser",
      "createrole",
      "updaterole",
      "droprole",
      "grantrolestorole",
      "revokerolesfromrole",
      "grantprivilegestorole",
      "revokeprivilegesfromrole",
    ]) {
      expect(IDENTITY_COMMANDS.has(command), `${command} must stay refused`).toBe(true);
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

  // Ungated drop-shaped tools are a deliberate call, not an oversight:
  // a single index is cheap to rebuild, a collection or database is not.
  // Anything new matching the shape has to be classified here or the suite
  // fails, so a gate can never be forgotten by simply not thinking about it.
  const GATED = [
    "dropCollection",
    "dropDatabase",
    "dropIndexes",
    "convertToCapped",
    "enableSharding",
    "shardCollection",
  ];
  const UNGATED_BY_DESIGN = ["dropIndex", "dropSearchIndex"];

  it("classifies every destructive-shaped tool as gated or deliberately ungated", () => {
    const shaped = [...tools.keys()].filter((n) => /^(drop|truncate|remove|purge)/.test(n));
    for (const name of shaped) {
      expect(
        GATED.includes(name) || UNGATED_BY_DESIGN.includes(name),
        `${name} looks irreversible: add it to GATED, or to UNGATED_BY_DESIGN with a reason`,
      ).toBe(true);
    }
  });

  it("gates every irreversible tool behind confirm: true", () => {
    const gated = GATED;
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

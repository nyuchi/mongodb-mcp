import type { McpServer } from "@modelcontextprotocol/server";
import type { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../src/audit";
import { buildRegistry, type Backends } from "../src/catalogue";
import type { Caller } from "../src/props";
import { accessOf, exposedName, ToolRegistry } from "../src/registry";
import type { RelayCall } from "../src/relay-client";
import { ALL_STORE_SCOPES, ENTRY_SCOPES, STORES, isPermitted, scopesFor } from "../src/scopes";
import { CASSANDRA_OPS, DORIS_DOMAINS, GRAPH_OPS } from "../src/stores/private";
import { assertReadShaped, type SqlRunner } from "../src/stores/supabase";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Mounted = {
  name: string;
  handler: (args: unknown, extra?: unknown) => Promise<Result>;
};

const noMongo = () => Promise.reject<MongoClient>(new Error("no cluster in tests"));
const sqlCalls: { access: string; sql: string }[] = [];
const fakeSql: SqlRunner = {
  configured: () => ({ read: true, write: false }),
  run: async (_project, access, sql) => {
    sqlCalls.push({ access, sql });
    return { rows: [{ ok: 1 }], truncated: false };
  },
};
const relayCalls: { store: string; op: string; args: unknown }[] = [];
const fakeRelay: RelayCall = async (store, op, args) => {
  relayCalls.push({ store, op, args });
  if (op === "callTool") return { content: [{ type: "text", text: "from doris" }] };
  return { rows: [] };
};
const backends: Backends = {
  mongoRead: noMongo,
  mongoWrite: noMongo,
  sql: fakeSql,
  relay: fakeRelay,
};

function fakeServer(): { server: McpServer; tools: Map<string, Mounted> } {
  const tools = new Map<string, Mounted>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Mounted["handler"]) {
      tools.set(name, { name, handler });
      return {};
    },
  } as unknown as McpServer;
  return { server, tools };
}

function caller(scopes: string[]): Caller {
  return {
    id: "user_test",
    email: "op@nyuchi.test",
    organizationId: "org_test",
    scopes,
  };
}

describe("scopes", () => {
  it("gives every store exactly an access and a write scope", () => {
    expect(ALL_STORE_SCOPES).toEqual(STORES.flatMap((s) => [`${s}:access`, `${s}:write`]));
    expect(ENTRY_SCOPES).toEqual(STORES.map((s) => `${s}:access`));
  });

  it("requires access for reads and access + write for writes", () => {
    expect(scopesFor("doris", "read")).toEqual(["doris:access"]);
    expect(scopesFor("doris", "write")).toEqual(["doris:access", "doris:write"]);
    expect(isPermitted(["mongodb:access"], "mongodb", "read")).toBe(true);
    expect(isPermitted(["mongodb:access"], "mongodb", "write")).toBe(false);
    // write without access is not a back door
    expect(isPermitted(["mongodb:write"], "mongodb", "write")).toBe(false);
    expect(isPermitted(["mongodb:write"], "mongodb", "read")).toBe(false);
    expect(isPermitted(["mongodb:access", "mongodb:write"], "mongodb", "write")).toBe(true);
  });

  it("never grants across stores or by prefix", () => {
    expect(isPermitted(["mongodb:access"], "supabase", "read")).toBe(false);
    for (const granted of ["doris:acces", "doris:access:admin", "xdoris:access", "doris"]) {
      expect(isPermitted([granted], "doris", "read")).toBe(false);
    }
  });
});

describe("tool registry", () => {
  const registry = buildRegistry(backends);
  const specs = registry.list();
  const byStore = (store: string) => specs.filter((s) => s.store === store).map((s) => s.name);

  it("namespaces every tool by its store", () => {
    for (const spec of specs) {
      expect(spec.name.startsWith(`${spec.store}_`), spec.name).toBe(true);
    }
    expect(exposedName("mongodb", "find")).toBe("mongodb_find");
    expect(exposedName("doris", "doris_query")).toBe("doris_query");
  });

  it("serves the exact catalogue for the non-Mongo stores", () => {
    expect(byStore("supabase").sort()).toEqual(
      ["listProjects", "listTables", "describeTable", "query", "execute"]
        .map((n) => `supabase_${n}`)
        .sort(),
    );
    expect(byStore("doris").sort()).toEqual(Object.keys(DORIS_DOMAINS).sort());
    expect(byStore("cassandra").sort()).toEqual(CASSANDRA_OPS.map((n) => `cassandra_${n}`).sort());
    expect(byStore("graph").sort()).toEqual(GRAPH_OPS.map((n) => `graph_${n}`).sort());
  });

  it("keeps the whole MongoDB catalogue, split between the two credentials", () => {
    const mongo = specs.filter((s) => s.store === "mongodb");
    expect(mongo.length).toBe(64);
    expect(mongo.find((s) => s.name === "mongodb_find")?.access).toBe("read");
    expect(mongo.find((s) => s.name === "mongodb_insertOne")?.access).toBe("write");
    expect(mongo.find((s) => s.name === "mongodb_dropCollection")?.access).toBe("write");
    expect(mongo.find((s) => s.name === "mongodb_runCommand")?.access).toBe("write");
  });

  it("derives access from readOnlyHint, and treats a missing hint as a write", () => {
    for (const spec of specs) {
      expect(spec.access).toBe(spec.config.annotations?.readOnlyHint === true ? "read" : "write");
    }
    expect(accessOf(undefined)).toBe("write");
    expect(accessOf({ readOnlyHint: false })).toBe("write");
    expect(accessOf({})).toBe("write");
  });

  it("marks every Doris domain read-only (Doris MCP 1.0 has no write domain)", () => {
    for (const spec of specs.filter((s) => s.store === "doris")) {
      expect(spec.access, spec.name).toBe("read");
    }
  });

  it("puts every irreversible tool behind write", () => {
    for (const spec of specs) {
      if (spec.config.annotations?.destructiveHint) expect(spec.access, spec.name).toBe("write");
    }
  });

  it("refuses a duplicate registration", () => {
    const r = new ToolRegistry();
    const sink = r.collector("graph");
    const register = () =>
      sink.registerTool(
        "x",
        { annotations: { readOnlyHint: true } } as never,
        (async () => ({
          content: [],
        })) as never,
      );
    register();
    expect(register).toThrow(/registered twice/);
  });
});

describe("scope gating", () => {
  const registry = buildRegistry(backends);

  it("shows nothing to a caller with no scopes", () => {
    expect(registry.permitted([])).toEqual([]);
    const { server, tools } = fakeServer();
    expect(registry.mount(server, caller([]), () => {})).toEqual([]);
    expect(tools.size).toBe(0);
  });

  it("shows exactly one store's read tools for its access scope", () => {
    for (const store of STORES) {
      const names = registry.permitted([`${store}:access`]);
      expect(names.length, store).toBeGreaterThan(0);
      for (const spec of names) {
        expect(spec.store).toBe(store);
        expect(spec.access).toBe("read");
      }
    }
  });

  it("adds a store's write tools only with access + write", () => {
    const readOnly = registry.permitted(["cassandra:access"]).map((s) => s.name);
    const readWrite = registry
      .permitted(["cassandra:access", "cassandra:write"])
      .map((s) => s.name);
    expect(readOnly).not.toContain("cassandra_execute");
    expect(readWrite).toContain("cassandra_execute");
    expect(registry.permitted(["cassandra:write"])).toEqual([]);
  });

  it("mounts only permitted tools on the server", () => {
    const { server, tools } = fakeServer();
    registry.mount(server, caller(["supabase:access", "graph:access"]), () => {});
    expect(
      [...tools.keys()].every((n) => n.startsWith("supabase_") || n.startsWith("graph_")),
    ).toBe(true);
    expect(tools.has("supabase_query")).toBe(true);
    expect(tools.has("supabase_execute")).toBe(false);
    expect(tools.has("graph_gremlin")).toBe(false);
    expect(tools.has("mongodb_find")).toBe(false);
  });

  it("re-checks scopes at call time", async () => {
    const scopes = ["graph:access"];
    const events: AuditEvent[] = [];
    const { server, tools } = fakeServer();
    registry.mount(server, caller(scopes), (e) => events.push(e));
    scopes.length = 0;
    const result = await tools.get("graph_summary")!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("graph:access");
    expect(events.at(-1)?.outcome).toBe("denied");
  });
});

describe("audit", () => {
  it("logs who, tool, store, access, outcome and duration — and nothing else", async () => {
    const events: AuditEvent[] = [];
    let now = 1_000;
    const { server, tools } = fakeServer();
    buildRegistry(backends).mount(
      server,
      caller(["supabase:access"]),
      (e) => events.push(e),
      () => (now += 7),
    );
    await tools.get("supabase_query")!.handler({
      project: "nyuchi_relational_db",
      sql: "select secret_column from very_private",
      params: ["hunter2"],
      limit: 5,
    });

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(Object.keys(event).sort()).toEqual(
      [
        "access",
        "at",
        "durationMs",
        "email",
        "event",
        "organizationId",
        "outcome",
        "store",
        "tool",
        "user",
      ].sort(),
    );
    expect(event).toMatchObject({
      event: "tool_call",
      user: "user_test",
      tool: "supabase_query",
      store: "supabase",
      access: "read",
      outcome: "ok",
      durationMs: 7,
    });
    const line = JSON.stringify(event);
    for (const leaked of ["secret_column", "very_private", "hunter2", 'ok":1']) {
      expect(line).not.toContain(leaked);
    }
  });

  it("records a failing tool as an error", async () => {
    const events: AuditEvent[] = [];
    const { server, tools } = fakeServer();
    buildRegistry(backends).mount(server, caller(["mongodb:access"]), (e) => events.push(e));
    const result = await tools.get("mongodb_listDatabases")!.handler({});
    expect(result.isError).toBe(true);
    expect(events.at(-1)).toMatchObject({
      tool: "mongodb_listDatabases",
      outcome: "error",
    });
  });
});

describe("store tools", () => {
  const { server, tools } = fakeServer();
  buildRegistry(backends).mount(server, caller([...ALL_STORE_SCOPES]), () => {});

  it("passes a Doris domain call through the relay unchanged", async () => {
    const input = {
      child_tool: "list_databases",
      arguments: { catalog: "internal" },
    };
    const result = await tools.get("doris_catalog")!.handler(input);
    expect(result.content[0].text).toBe("from doris");
    expect(relayCalls.at(-1)).toEqual({
      store: "doris",
      op: "callTool",
      args: { tool: "doris_catalog", input },
    });
  });

  it("sends Cassandra and graph ops by their bare names", async () => {
    await tools.get("cassandra_listKeyspaces")!.handler({});
    expect(relayCalls.at(-1)).toMatchObject({
      store: "cassandra",
      op: "listKeyspaces",
    });
    await tools.get("graph_neighbours")!.handler({ vertexId: 1, direction: "out", limit: 5 });
    expect(relayCalls.at(-1)).toMatchObject({
      store: "graph",
      op: "neighbours",
    });
  });

  it("runs supabase_query with the read credential and supabase_execute with the write one", async () => {
    await tools.get("supabase_query")!.handler({
      project: "mzizi_db",
      sql: "select 1",
      params: [],
      limit: 1,
    });
    expect(sqlCalls.at(-1)).toEqual({ access: "read", sql: "select 1" });
    await tools.get("supabase_execute")!.handler({
      project: "mzizi_db",
      sql: "delete from t",
      params: [],
      confirm: true,
    });
    expect(sqlCalls.at(-1)).toEqual({ access: "write", sql: "delete from t" });
  });

  it("turns away an obvious write sent to supabase_query", async () => {
    const result = await tools.get("supabase_query")!.handler({
      project: "mzizi_db",
      sql: "delete from t",
      params: [],
      limit: 1,
    });
    expect(result.isError).toBe(true);
    expect(() => assertReadShaped("  WITH x AS (select 1) select * from x")).not.toThrow();
    expect(() => assertReadShaped("update t set a = 1")).toThrow(/supabase_execute/);
  });
});

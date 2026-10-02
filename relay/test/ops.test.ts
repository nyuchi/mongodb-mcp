import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { authorise, checkCql, DORIS_TOOLS, OPS, type Backends, type CallBody } from "../src/ops.ts";

const body = (store: string, op: string, scopes: string[]): CallBody =>
  ({ store, op, args: {}, caller: { id: "user_1", scopes } }) as CallBody;

// The Worker's tool lists, read from its source so the two cannot drift.
function workerList(name: string): string[] {
  const source = readFileSync(new URL("../../src/stores/private.ts", import.meta.url), "utf8");
  const match = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `${name} not found in src/stores/private.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("op table", () => {
  it("matches the Worker's Cassandra and graph tools exactly", () => {
    const ops = (store: string) =>
      Object.keys(OPS)
        .filter((k) => k.startsWith(`${store}.`))
        .map((k) => k.slice(store.length + 1))
        .sort();
    assert.deepEqual(ops("cassandra"), workerList("CASSANDRA_OPS").sort());
    assert.deepEqual(ops("graph"), workerList("GRAPH_OPS").sort());
    assert.deepEqual(ops("doris"), ["callTool"]);
  });

  it("allows exactly the eight Doris MCP 1.0 domains", () => {
    const source = readFileSync(new URL("../../src/stores/private.ts", import.meta.url), "utf8");
    const workerDomains = [...source.matchAll(/^\s+(doris_[a-z]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual([...DORIS_TOOLS].sort(), workerDomains);
    assert.equal(DORIS_TOOLS.size, 8);
  });

  it("classifies only cassandra.execute and graph.gremlin as writes", () => {
    const writes = Object.entries(OPS)
      .filter(([, spec]) => spec.access === "write")
      .map(([name]) => name)
      .sort();
    assert.deepEqual(writes, ["cassandra.execute", "graph.gremlin"]);
  });
});

describe("authorise", () => {
  const none = new Set<string>();

  it("admits a read with the store's access scope", () => {
    assert.equal(authorise(body("graph", "summary", ["graph:access"]), none).access, "read");
  });

  it("refuses a read without the scope, or with another store's", () => {
    for (const scopes of [[], ["doris:access"], ["graph:write"], ["graph:accessx"]]) {
      assert.throws(() => authorise(body("graph", "summary", scopes), none), {
        status: 403,
      });
    }
  });

  it("refuses writes unless the caller has access + write AND the relay allows that store", () => {
    const rw = ["cassandra:access", "cassandra:write"];
    assert.throws(
      () => authorise(body("cassandra", "execute", ["cassandra:access"]), new Set(["cassandra"])),
      {
        status: 403,
      },
    );
    assert.throws(() => authorise(body("cassandra", "execute", rw), none), /RELAY_ALLOW_WRITES/);
    assert.throws(
      () => authorise(body("cassandra", "execute", rw), new Set(["graph"])),
      /disabled/,
    );
    assert.equal(
      authorise(body("cassandra", "execute", rw), new Set(["cassandra"])).access,
      "write",
    );
  });

  it("refuses unknown operations", () => {
    assert.throws(() => authorise(body("doris", "dropTable", ["doris:access"]), none), {
      status: 404,
    });
    assert.throws(() => authorise(body("mongodb", "find", ["mongodb:access"]), none), {
      status: 404,
    });
  });
});

describe("guards", () => {
  it("lets cassandra_select run SELECT only, one statement", () => {
    assert.doesNotThrow(() => checkCql("read", "SELECT * FROM nhaka.news_articles LIMIT 5;"));
    assert.throws(() => checkCql("read", "DELETE FROM nhaka.news_articles WHERE id = ?"));
    assert.throws(() => checkCql("read", "SELECT 1 FROM t; DROP TABLE t"));
  });

  it("keeps schema changes out of cassandra_execute", () => {
    assert.doesNotThrow(() => checkCql("write", "INSERT INTO nhaka.t (id) VALUES (?)"));
    assert.doesNotThrow(() =>
      checkCql("write", "BEGIN UNLOGGED BATCH INSERT INTO t (id) VALUES (1) APPLY BATCH"),
    );
    for (const ddl of [
      "DROP TABLE nhaka.t",
      "TRUNCATE nhaka.t",
      "GRANT ALL ON KEYSPACE nhaka TO x",
      "ALTER ROLE x WITH SUPERUSER = true",
    ]) {
      assert.throws(() => checkCql("write", ddl), ddl);
    }
  });

  it("refuses an unknown Doris tool even with doris:access", async () => {
    const backends = {
      doris: { callTool: async () => "called" },
    } as unknown as Backends;
    await assert.rejects(
      async () => OPS["doris.callTool"].run(backends, { tool: "doris_admin", input: {} }),
      /unknown Doris tool/,
    );
    assert.equal(
      await OPS["doris.callTool"].run(backends, {
        tool: "doris_query",
        input: {},
      }),
      "called",
    );
  });

  it("passes keyspace names to Cassandra as bind values and rejects odd identifiers", async () => {
    const calls: unknown[][] = [];
    const backends = {
      cassandra: {
        execute: async (...a: unknown[]) => (calls.push(a), { rows: [], truncated: false }),
      },
    } as unknown as Backends;
    await OPS["cassandra.listTables"].run(backends, { keyspace: "nhaka" });
    assert.deepEqual(calls[0][2], ["nhaka"]);
    assert.equal(calls[0][0], "read");
    await assert.rejects(
      async () => OPS["cassandra.listTables"].run(backends, { keyspace: "x'; DROP" }),
      /identifier/,
    );
  });
});

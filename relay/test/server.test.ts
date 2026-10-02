import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signRequest } from "../../src/relay-signing.ts";
import type { Backends } from "../src/ops.ts";
import { CALL_PATH, handle, NonceCache, type RelayDeps } from "../src/server.ts";

const SECRET = "relay-test-secret-0123456789abcdef0123456789";
const NOW = 1_800_000_000_000;

function deps(
  overrides: Partial<RelayDeps> = {},
): RelayDeps & { lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const backends = {
    doris: {
      callTool: async (tool: string) => ({
        content: [{ type: "text", text: tool }],
      }),
    },
    cassandra: {
      execute: async () => ({ rows: [{ a: 1 }], truncated: false }),
    },
    graph: { summary: async () => ({ vertices: {}, edges: {} }) },
  } as unknown as Backends;
  return {
    secret: SECRET,
    allowWrites: new Set(),
    backends,
    nonces: new NonceCache(),
    now: () => NOW,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

async function signedCall(payload: unknown, nonce: string = crypto.randomUUID(), path = CALL_PATH) {
  const body = JSON.stringify(payload);
  const headers = await signRequest(SECRET, "POST", path, body, NOW, nonce);
  return {
    method: "POST",
    path,
    body,
    header: (n: string) => headers[n] ?? null,
  };
}

const doris = {
  store: "doris",
  op: "callTool",
  args: { tool: "doris_catalog", input: {} },
  caller: { id: "user_1", email: "op@nyuchi.test", scopes: ["doris:access"] },
};

describe("relay handler", () => {
  it("runs a signed, permitted call and audits it without its arguments or result", async () => {
    const d = deps();
    const res = await handle(await signedCall(doris), d);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, {
      ok: true,
      result: { content: [{ type: "text", text: "doris_catalog" }] },
    });
    assert.equal(d.lines.length, 1);
    assert.deepEqual(Object.keys(d.lines[0]).sort(), [
      "access",
      "at",
      "durationMs",
      "email",
      "event",
      "op",
      "outcome",
      "store",
      "user",
    ]);
    assert.equal(d.lines[0].outcome, "ok");
  });

  it("refuses an unsigned or tampered request with 401", async () => {
    const call = await signedCall(doris);
    assert.equal((await handle({ ...call, header: () => null }, deps())).status, 401);
    assert.equal(
      (await handle({ ...call, body: call.body.replace("doris:access", "graph:access") }, deps()))
        .status,
      401,
    );
  });

  it("refuses a replayed nonce", async () => {
    const d = deps();
    const call = await signedCall(doris, "fixed-nonce-0123456789");
    assert.equal((await handle(call, d)).status, 200);
    assert.equal((await handle(call, d)).status, 401);
    assert.equal(d.lines.at(-1)?.reason, "nonce reused");
  });

  it("refuses a caller without the store's scope with 403, and audits it as denied", async () => {
    const d = deps();
    const res = await handle(
      await signedCall({
        ...doris,
        caller: { id: "user_2", scopes: ["graph:access"] },
      }),
      d,
    );
    assert.equal(res.status, 403);
    assert.equal(d.lines.at(-1)?.outcome, "denied");
  });

  it("keeps writes off unless RELAY_ALLOW_WRITES names the store", async () => {
    const write = {
      store: "cassandra",
      op: "execute",
      args: {
        cql: "DELETE FROM nhaka.t WHERE id = ?",
        params: [1],
        confirm: true,
      },
      caller: { id: "user_1", scopes: ["cassandra:access", "cassandra:write"] },
    };
    assert.equal((await handle(await signedCall(write), deps())).status, 403);
    assert.equal(
      (await handle(await signedCall(write), deps({ allowWrites: new Set(["cassandra"]) }))).status,
      200,
    );
  });

  it("answers health checks and nothing else unauthenticated", async () => {
    assert.equal(
      (await handle({ method: "GET", path: "/healthz", body: "", header: () => null }, deps()))
        .status,
      200,
    );
    assert.equal(
      (await handle({ method: "GET", path: "/", body: "", header: () => null }, deps())).status,
      404,
    );
    assert.equal(
      (await handle({ method: "GET", path: CALL_PATH, body: "", header: () => null }, deps()))
        .status,
      405,
    );
  });
});

describe("NonceCache", () => {
  it("expires entries after its TTL", () => {
    const cache = new NonceCache(1000);
    assert.equal(cache.claim("a", 0), true);
    assert.equal(cache.claim("a", 500), false);
    assert.equal(cache.claim("b", 1500), true);
    assert.equal(cache.claim("a", 1600), true);
  });
});

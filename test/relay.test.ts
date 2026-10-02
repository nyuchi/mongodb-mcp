import { describe, expect, it } from "vitest";
import { relayCaller, RELAY_CALL_PATH, type RelayCallBody } from "../src/relay-client";
import {
  RELAY_HEADERS,
  RELAY_MAX_SKEW_SECONDS,
  signRequest,
  verifyRequest,
} from "../src/relay-signing";

const SECRET = "test-relay-secret-0123456789abcdef0123456789";
const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ store: "doris", op: "callTool" });

async function signed(body = BODY, now = NOW) {
  const headers = await signRequest(
    SECRET,
    "POST",
    RELAY_CALL_PATH,
    body,
    now,
    "nonce-0123456789abcdef",
  );
  return (name: string) => headers[name] ?? null;
}

describe("relay request signing", () => {
  it("verifies its own signature", async () => {
    const result = await verifyRequest(SECRET, "POST", RELAY_CALL_PATH, BODY, await signed(), NOW);
    expect(result).toEqual({ ok: true, nonce: "nonce-0123456789abcdef" });
  });

  it("rejects a changed body, path, method or secret", async () => {
    const header = await signed();
    const cases = [
      verifyRequest(SECRET, "POST", RELAY_CALL_PATH, BODY + " ", header, NOW),
      verifyRequest(SECRET, "POST", "/v1/other", BODY, header, NOW),
      verifyRequest(SECRET, "PUT", RELAY_CALL_PATH, BODY, header, NOW),
      verifyRequest(SECRET + "x", "POST", RELAY_CALL_PATH, BODY, header, NOW),
    ];
    for (const result of await Promise.all(cases)) {
      expect(result).toEqual({ ok: false, reason: "bad signature" });
    }
  });

  it("rejects a request outside the clock-skew window", async () => {
    const header = await signed(BODY, NOW - (RELAY_MAX_SKEW_SECONDS + 1) * 1000);
    const result = await verifyRequest(SECRET, "POST", RELAY_CALL_PATH, BODY, header, NOW);
    expect(result).toEqual({ ok: false, reason: "timestamp outside window" });
  });

  it("rejects missing or malformed headers", async () => {
    const header = await signed();
    const without = (name: string) => (n: string) => (n === name ? null : header(n));
    for (const name of Object.values(RELAY_HEADERS)) {
      const result = await verifyRequest(SECRET, "POST", RELAY_CALL_PATH, BODY, without(name), NOW);
      expect(result.ok).toBe(false);
    }
    const garbled = (n: string) => (n === RELAY_HEADERS.signature ? "not base64!" : header(n));
    expect(await verifyRequest(SECRET, "POST", RELAY_CALL_PATH, BODY, garbled, NOW)).toEqual({
      ok: false,
      reason: "malformed signature",
    });
  });

  it("refuses a short secret on either side", async () => {
    await expect(signRequest("short", "POST", "/", "")).rejects.toThrow(/at least 32/);
  });
});

describe("relayCaller", () => {
  const caller = {
    id: "user_1",
    email: "op@nyuchi.test",
    scopes: ["doris:access"],
  };

  it("signs the body it sends and carries the caller inside it", async () => {
    let seen: Request | undefined;
    const call = relayCaller(
      {
        url: "https://relay.test",
        secret: SECRET,
        fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
          seen = new Request(input, init);
          return Response.json({ ok: true, result: { rows: [] } });
        }) as typeof fetch,
      },
      caller,
    );
    expect(await call("doris", "callTool", { tool: "doris_catalog", input: {} })).toEqual({
      rows: [],
    });
    expect(seen!.url).toBe(`https://relay.test${RELAY_CALL_PATH}`);
    const body = await seen!.text();
    expect((JSON.parse(body) as RelayCallBody).caller).toEqual(caller);
    const verdict = await verifyRequest(SECRET, "POST", RELAY_CALL_PATH, body, (n) =>
      seen!.headers.get(n),
    );
    expect(verdict.ok).toBe(true);
  });

  it("surfaces a relay refusal as an error", async () => {
    const call = relayCaller(
      {
        url: "https://relay.test",
        secret: SECRET,
        fetch: (async () =>
          Response.json({ ok: false, error: "writes disabled" }, { status: 403 })) as never,
      },
      caller,
    );
    await expect(call("cassandra", "execute", {})).rejects.toThrow("Relay: writes disabled");
  });

  it("explains when the relay is not configured", async () => {
    await expect(relayCaller({}, caller)("graph", "summary", {})).rejects.toThrow(/RELAY_URL/);
  });
});

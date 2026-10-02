import type { Caller } from "./props";
import { signRequest } from "./relay-signing";

// The stores that live on Fly's private network (6PN). A Worker cannot reach
// 6PN, so their tools call the relay (relay/ in this repo), which can.
export type RelayStore = "doris" | "cassandra" | "graph";

export const RELAY_CALL_PATH = "/v1/call";

// The wire contract with relay/src/server.ts. `caller` travels inside the
// signed body so the relay can re-check scopes and write its own audit line;
// it is a statement by the Worker, trusted because the body is signed.
export interface RelayCallBody {
  store: RelayStore;
  op: string;
  args: unknown;
  caller: { id: string; email?: string; scopes: readonly string[] };
}

export type RelayReply = { ok: true; result: unknown } | { ok: false; error: string };

export type RelayCall = (store: RelayStore, op: string, args: unknown) => Promise<unknown>;

export interface RelayConfig {
  url?: string;
  secret?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

// Binds a caller to the relay so tool handlers only pass (store, op, args).
// Unconfigured, it still returns a function — one that explains what is
// missing — so the tools stay listed and fail with a reason, not silently.
export function relayCaller(config: RelayConfig, caller: Caller): RelayCall {
  return async (store, op, args) => {
    if (!config.url || !config.secret) {
      throw new Error(
        "The private-network relay is not configured on this worker (RELAY_URL and RELAY_SIGNING_SECRET).",
      );
    }
    const body = JSON.stringify({
      store,
      op,
      args,
      caller: { id: caller.id, email: caller.email, scopes: caller.scopes },
    } satisfies RelayCallBody);
    const headers = await signRequest(config.secret, "POST", RELAY_CALL_PATH, body);
    const doFetch = config.fetch ?? fetch;
    const response = await doFetch(new URL(RELAY_CALL_PATH, config.url).href, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
    });

    let reply: RelayReply;
    try {
      reply = (await response.json()) as RelayReply;
    } catch {
      throw new Error(`Relay answered ${response.status} with a non-JSON body.`);
    }
    if (!reply.ok) throw new Error(`Relay: ${reply.error}`);
    return reply.result;
  };
}

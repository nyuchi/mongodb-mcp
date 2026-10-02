import { createServer, type IncomingMessage, type Server } from "node:http";
import { RELAY_MAX_SKEW_SECONDS, verifyRequest } from "../../src/relay-signing.ts";
import { authorise, parseBody, RelayError, type Backends } from "./ops.ts";

export const CALL_PATH = "/v1/call";
const MAX_BODY_BYTES = 256 * 1024;

// Nonces seen inside the skew window. A replay within the window is refused;
// past it the timestamp check refuses it, so entries can expire then. The
// cache is per machine — the relay runs as one machine (fly.toml), and the
// design doc covers what changes if that ever grows.
export class NonceCache {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = (RELAY_MAX_SKEW_SECONDS * 2 + 5) * 1000) {
    this.ttlMs = ttlMs;
  }

  // True the first time a nonce is offered, false on every reuse.
  claim(nonce: string, now: number): boolean {
    for (const [key, expires] of this.seen) {
      if (expires > now) break;
      this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

export interface RelayDeps {
  secret: string;
  allowWrites: ReadonlySet<string>;
  backends: Backends;
  nonces: NonceCache;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
}

export interface RelayRequest {
  method: string;
  path: string;
  header: (name: string) => string | null | undefined;
  body: string;
}

export interface RelayResponse {
  status: number;
  json: unknown;
}

export async function handle(req: RelayRequest, deps: RelayDeps): Promise<RelayResponse> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));

  if (req.method === "GET" && req.path === "/healthz") return { status: 200, json: { ok: true } };
  if (req.path !== CALL_PATH) return { status: 404, json: { ok: false, error: "not found" } };
  if (req.method !== "POST")
    return { status: 405, json: { ok: false, error: "method not allowed" } };

  const verdict = await verifyRequest(
    deps.secret,
    req.method,
    req.path,
    req.body,
    req.header,
    now(),
  );
  if (!verdict.ok) {
    log({
      event: "relay_rejected",
      at: new Date(now()).toISOString(),
      reason: verdict.reason,
    });
    return { status: 401, json: { ok: false, error: "unauthorised" } };
  }
  if (!deps.nonces.claim(verdict.nonce, now())) {
    log({
      event: "relay_rejected",
      at: new Date(now()).toISOString(),
      reason: "nonce reused",
    });
    return { status: 401, json: { ok: false, error: "unauthorised" } };
  }

  const started = now();
  let audit: Record<string, unknown> = {
    event: "relay_call",
    at: new Date(started).toISOString(),
  };
  try {
    const body = parseBody(req.body);
    audit = {
      ...audit,
      user: body.caller.id,
      email: body.caller.email,
      store: body.store,
      op: body.op,
    };
    const spec = authorise(body, deps.allowWrites);
    audit.access = spec.access;
    const args =
      body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
    const result = await spec.run(deps.backends, args);
    log({ ...audit, outcome: "ok", durationMs: now() - started });
    return { status: 200, json: { ok: true, result } };
  } catch (err) {
    const status = err instanceof RelayError ? err.status : 502;
    const message = err instanceof Error ? err.message : String(err);
    log({
      ...audit,
      outcome: status === 403 ? "denied" : "error",
      durationMs: now() - started,
    });
    return { status, json: { ok: false, error: message } };
  }
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startServer(port: number, deps: RelayDeps): Server {
  const server = createServer(async (req, res) => {
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(json));
    };
    try {
      const body = await readBody(req);
      if (body === null) return reply(413, { ok: false, error: "body too large" });
      const url = new URL(req.url ?? "/", "http://relay.internal");
      const { status, json } = await handle(
        {
          method: req.method ?? "GET",
          path: url.pathname,
          header: (name) => {
            const value = req.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] : value;
          },
          body,
        },
        deps,
      );
      reply(status, json);
    } catch {
      reply(500, { ok: false, error: "internal error" });
    }
  });
  server.listen(port, "::");
  return server;
}

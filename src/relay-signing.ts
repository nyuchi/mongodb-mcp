// Request signing between the Worker and the private-network relay on Fly.
//
// Shared verbatim by both sides: the Worker imports it to sign, the relay
// (relay/src/server.ts) imports it to verify. It therefore uses only WebCrypto
// and erasable TypeScript, which run unchanged in workerd and in Node 24 with
// native type stripping, and imports nothing.
//
// Signature = HMAC-SHA256(secret, canonical string), base64url. The canonical
// string binds the method, path, a timestamp, a single-use nonce and the
// SHA-256 of the exact body bytes, so a captured request cannot be replayed
// after the skew window, replayed within it (nonce), retargeted to another
// path, or have its body changed.

export const RELAY_HEADERS = {
  timestamp: "x-nyuchi-relay-timestamp",
  nonce: "x-nyuchi-relay-nonce",
  signature: "x-nyuchi-relay-signature",
} as const;

export const RELAY_MAX_SKEW_SECONDS = 60;
const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function sha256Hex(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function canonicalString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: string,
): Promise<string> {
  return [method.toUpperCase(), path, timestamp, nonce, await sha256Hex(body)].join("\n");
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<HmacKey> {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `RELAY_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters (use openssl rand -hex 32).`,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  now: number = Date.now(),
  nonce: string = crypto.randomUUID(),
): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(now / 1000));
  const key = await hmacKey(secret, "sign");
  const message = await canonicalString(method, path, timestamp, nonce, body);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return {
    [RELAY_HEADERS.timestamp]: timestamp,
    [RELAY_HEADERS.nonce]: nonce,
    [RELAY_HEADERS.signature]: base64Url(signature),
  };
}

export type VerifyResult = { ok: true; nonce: string } | { ok: false; reason: string };

// Checks everything except nonce reuse, which needs state the caller owns (the
// relay keeps a cache of nonces seen inside the skew window).
export async function verifyRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  header: (name: string) => string | null | undefined,
  now: number = Date.now(),
): Promise<VerifyResult> {
  const timestamp = header(RELAY_HEADERS.timestamp) ?? "";
  const nonce = header(RELAY_HEADERS.nonce) ?? "";
  const signature = header(RELAY_HEADERS.signature) ?? "";
  if (!timestamp || !nonce || !signature) return { ok: false, reason: "missing signature headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed timestamp" };
  if (nonce.length < 16 || nonce.length > 128) return { ok: false, reason: "malformed nonce" };

  const skew = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (skew > RELAY_MAX_SKEW_SECONDS) return { ok: false, reason: "timestamp outside window" };

  const provided = fromBase64Url(signature);
  if (!provided) return { ok: false, reason: "malformed signature" };

  const key = await hmacKey(secret, "verify");
  const message = await canonicalString(method, path, timestamp, nonce, body);
  // subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", key, provided, encoder.encode(message));
  return valid ? { ok: true, nonce } : { ok: false, reason: "bad signature" };
}

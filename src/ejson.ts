import { EJSON } from "bson";
import type { Document } from "bson";

const MAX_BYTES = 256 * 1024;

export function parseExtendedJson<T = Document>(input: unknown): T {
  if (input === undefined || input === null) return input as T;
  if (typeof input === "string") return EJSON.parse(input) as T;
  // Round-trip plain JS objects so nested `$oid` / `$date` markers become BSON types.
  return EJSON.parse(JSON.stringify(input)) as T;
}

export function stringifyEJson(value: unknown): string {
  const text = EJSON.stringify(value, { relaxed: true });
  if (text.length <= MAX_BYTES) return text;
  return text.slice(0, MAX_BYTES) + `\n…[truncated, ${text.length - MAX_BYTES} more chars]`;
}

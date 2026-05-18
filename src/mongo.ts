import { EJSON } from "bson";
import { MongoClient, type Document, type MongoClientOptions } from "mongodb";

const MAX_BYTES = 256 * 1024;

export function parseExtendedJson<T = Document>(input: unknown): T {
  if (input === undefined || input === null) return input as T;
  if (typeof input === "string") return EJSON.parse(input) as T;
  // Accept already-parsed objects too; round-trip through EJSON so that any
  // `$oid`/`$date` style markers nested in plain JSON are coerced into BSON types.
  return EJSON.parse(JSON.stringify(input)) as T;
}

export function stringifyEJson(value: unknown): string {
  const text = EJSON.stringify(value, { relaxed: true });
  if (text.length <= MAX_BYTES) return text;
  return text.slice(0, MAX_BYTES) + `\n…[truncated, ${text.length - MAX_BYTES} more chars]`;
}

export function buildClient(uri: string): MongoClient {
  // Conservative pool size — Workers/Durable Objects are short-lived.
  const options: MongoClientOptions = {
    appName: "mongodb-mcp/cloudflare-worker",
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
  };
  return new MongoClient(uri, options);
}

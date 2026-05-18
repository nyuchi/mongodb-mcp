import { MongoClient, type MongoClientOptions } from "mongodb";

export { parseExtendedJson, stringifyEJson } from "./ejson";

export function buildClient(uri: string): MongoClient {
  // Conservative pool — Workers / Durable Objects are short-lived.
  const options: MongoClientOptions = {
    appName: "mongodb-mcp/cloudflare-worker",
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10_000,
  };
  return new MongoClient(uri, options);
}

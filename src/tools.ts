import type { McpServer } from "@modelcontextprotocol/server";
import type { AnyBulkWriteOperation, Document, MongoClient } from "mongodb";
import { z } from "zod";
import { parseExtendedJson, stringifyEJson } from "./ejson";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: stringifyEJson(value) }] };
}

// MongoDB server error codes we want to surface with extra guidance.
// https://github.com/mongodb/mongo/blob/master/src/mongo/base/error_codes.yml
const AUTH_ERROR_CODES = new Set([
  13, // Unauthorized
  18, // AuthenticationFailed
  31, // RoleNotFound
  33, // UserNotFound
  390, // CommandNotSupportedOnView
]);

export function permissionHint(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown };
  const code = typeof e.code === "number" ? e.code : undefined;
  const codeName = typeof e.codeName === "string" ? e.codeName : "";
  const message = typeof e.message === "string" ? e.message : "";

  const looksAuth =
    (code !== undefined && AUTH_ERROR_CODES.has(code)) ||
    codeName === "Unauthorized" ||
    codeName === "AuthenticationFailed" ||
    /not authorized on|requires authentication|command .* requires/i.test(message);

  if (!looksAuth) return null;

  if (codeName === "AuthenticationFailed" || code === 18) {
    return "AuthenticationFailed: the MONGODB_URI credentials are wrong or the user does not exist on the auth database. Verify the username/password and the authSource in the connection string.";
  }
  return "Unauthorized: the MongoDB user in MONGODB_URI lacks privileges for this operation. Grant a role that covers it on the target database, e.g. `readWrite` (CRUD + createIndex/dropIndex), `dbAdmin` (DDL, profiler, views), or `dbOwner` (both). For cluster-wide access use `readWriteAnyDatabase` / `dbAdminAnyDatabase`; monitoring and sharding tools need `clusterMonitor` / `clusterManager` on `admin`. Do not grant `userAdmin` to work around this — this server deliberately exposes no identity management. See README → 'MongoDB user role requirements'.";
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const hint = permissionHint(err);
  const text = hint ? `${message}\n\n${hint}` : message;
  return { content: [{ type: "text", text }], isError: true };
}

const dbArg = { db: z.string().describe("Database name").min(1) };
const collArg = { ...dbArg, collection: z.string().describe("Collection name").min(1) };

const jsonDoc = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    "Document or filter. JSON object or a JSON/Extended JSON string. Use $oid, $date, etc. for BSON types.",
  );

const jsonArray = z
  .union([z.string(), z.array(z.unknown())])
  .describe("Array of documents (JSON / Extended JSON).");

// MCP tool annotations: advisory hints clients use to render and guard tools.
// `readOnlyHint` tools never mutate; `destructiveHint` tools may overwrite or
// remove data; `idempotentHint` tools are safe to retry with identical args.
// `openWorldHint` stays false — every tool acts only on the connected MongoDB
// cluster, a closed system (runCommand is the one open-ended exception).
export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const ADD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
export const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

// Identity management is deliberately not exposed. MongoDB grants user and role
// administration through `userAdmin`, which cannot be narrowed to "may only
// touch these users" — a credential holding it can mint a root user and
// escalate past every other limit this server places on itself. So the tools
// are absent and `runCommand` refuses the same commands; otherwise it would be
// a one-line bypass of their removal. Manage identities in the Atlas UI or a
// separately-credentialled admin path instead.
export const IDENTITY_COMMANDS = new Set(
  [
    "createUser",
    "updateUser",
    "dropUser",
    "dropAllUsersFromDatabase",
    "grantRolesToUser",
    "revokeRolesFromUser",
    "usersInfo",
    "createRole",
    "updateRole",
    "dropRole",
    "dropAllRolesFromDatabase",
    "grantRolesToRole",
    "revokeRolesFromRole",
    "grantPrivilegesToRole",
    "revokePrivilegesFromRole",
    "rolesInfo",
    "invalidateUserCache",
  ].map((name) => name.toLowerCase()),
);

export function assertNotIdentityCommand(command: Document): void {
  for (const key of Object.keys(command)) {
    if (IDENTITY_COMMANDS.has(key.toLowerCase())) {
      throw new Error(
        `Refused: '${key}' is a user/role administration command. This server does not expose identity management, because the userAdmin privilege it requires cannot be scoped and would allow privilege escalation. Manage users and roles in the Atlas UI instead.`,
      );
    }
  }
}

type ToolHints = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export function registerMongoTools(server: McpServer, getClient: () => Promise<MongoClient>) {
  // SDK v2 takes one config object and a schema rather than v1's positional
  // shape. Funnelling every registration through here keeps the 60-odd call
  // sites reading as `name, description, args, hints, handler` and puts the
  // z.object() wrapping in one place.
  const tool = <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    { title, ...behaviour }: ToolHints,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>,
  ) => {
    server.registerTool(
      name,
      { title, description, inputSchema: z.object(shape), annotations: behaviour },
      handler as never,
    );
  };

  // ---------- discovery ----------

  tool(
    "listDatabases",
    "List databases on the cluster with their size on disk.",
    {},
    { ...READ, title: "List databases" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").admin().listDatabases();
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "listCollections",
    "List collections in a database.",
    { ...dbArg },
    { ...READ, title: "List collections" },
    async ({ db }) => {
      try {
        const client = await getClient();
        const cols = await client.db(db).listCollections().toArray();
        return ok(cols);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dbStats",
    "Return db.stats() for a database.",
    { ...dbArg },
    { ...READ, title: "Database stats" },
    async ({ db }) => {
      try {
        const client = await getClient();
        const stats = await client.db(db).stats();
        return ok(stats);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "collStats",
    "Return collStats for a collection (via $collStats aggregation).",
    { ...collArg },
    { ...READ, title: "Collection stats" },
    async ({ db, collection }) => {
      try {
        const client = await getClient();
        const stats = await client
          .db(db)
          .collection(collection)
          .aggregate([{ $collStats: { storageStats: {} } }])
          .toArray();
        return ok(stats);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- reads ----------

  tool(
    "find",
    "Run find() against a collection. Returns up to `limit` documents.",
    {
      ...collArg,
      filter: jsonDoc.optional(),
      projection: jsonDoc.optional(),
      sort: jsonDoc.optional(),
      limit: z.number().int().min(1).max(1000).default(50),
      skip: z.number().int().min(0).default(0),
    },
    { ...READ, title: "Find documents" },
    async ({ db, collection, filter, projection, sort, limit, skip }) => {
      try {
        const client = await getClient();
        const cursor = client
          .db(db)
          .collection(collection)
          .find(parseExtendedJson<Document>(filter ?? {}), {
            projection: projection ? parseExtendedJson<Document>(projection) : undefined,
            sort: sort ? parseExtendedJson<Document>(sort) : undefined,
            limit,
            skip,
          });
        const docs = await cursor.toArray();
        return ok({ count: docs.length, documents: docs });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "findOne",
    "Return a single document.",
    {
      ...collArg,
      filter: jsonDoc.optional(),
      projection: jsonDoc.optional(),
    },
    { ...READ, title: "Find one document" },
    async ({ db, collection, filter, projection }) => {
      try {
        const client = await getClient();
        const doc = await client
          .db(db)
          .collection(collection)
          .findOne(parseExtendedJson<Document>(filter ?? {}), {
            projection: projection ? parseExtendedJson<Document>(projection) : undefined,
          });
        return ok(doc);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "count",
    "Count documents matching a filter (countDocuments).",
    { ...collArg, filter: jsonDoc.optional() },
    { ...READ, title: "Count documents" },
    async ({ db, collection, filter }) => {
      try {
        const client = await getClient();
        const count = await client
          .db(db)
          .collection(collection)
          .countDocuments(parseExtendedJson<Document>(filter ?? {}));
        return ok({ count });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "aggregate",
    "Run an aggregation pipeline. Note: $out / $merge stages write to a collection.",
    {
      ...collArg,
      pipeline: jsonArray,
      limit: z.number().int().min(1).max(1000).default(100),
    },
    { ...ADD, title: "Run aggregation" },
    async ({ db, collection, pipeline, limit }) => {
      try {
        const client = await getClient();
        const stages = parseExtendedJson<Document[]>(pipeline);
        if (!Array.isArray(stages)) throw new Error("pipeline must be an array of stages");
        const docs = await client
          .db(db)
          .collection(collection)
          .aggregate([...stages, { $limit: limit }])
          .toArray();
        return ok({ count: docs.length, documents: docs });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- writes ----------

  tool(
    "insertOne",
    "Insert a single document.",
    { ...collArg, document: jsonDoc },
    { ...ADD, title: "Insert document" },
    async ({ db, collection, document }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .insertOne(parseExtendedJson<Document>(document));
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "insertMany",
    "Insert multiple documents.",
    { ...collArg, documents: jsonArray, ordered: z.boolean().default(true) },
    { ...ADD, title: "Insert documents" },
    async ({ db, collection, documents, ordered }) => {
      try {
        const client = await getClient();
        const docs = parseExtendedJson<Document[]>(documents);
        if (!Array.isArray(docs)) throw new Error("documents must be an array");
        const result = await client.db(db).collection(collection).insertMany(docs, { ordered });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "updateOne",
    "Update a single document.",
    {
      ...collArg,
      filter: jsonDoc,
      update: jsonDoc.describe("Update document or pipeline. Use operators like $set."),
      upsert: z.boolean().default(false),
    },
    { ...MUTATE, title: "Update document" },
    async ({ db, collection, filter, update, upsert }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .updateOne(parseExtendedJson<Document>(filter), parseExtendedJson<Document>(update), {
            upsert,
          });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "updateMany",
    "Update many documents.",
    {
      ...collArg,
      filter: jsonDoc,
      update: jsonDoc,
      upsert: z.boolean().default(false),
    },
    { ...MUTATE, title: "Update documents" },
    async ({ db, collection, filter, update, upsert }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .updateMany(parseExtendedJson<Document>(filter), parseExtendedJson<Document>(update), {
            upsert,
          });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "deleteOne",
    "Delete a single document matching the filter.",
    { ...collArg, filter: jsonDoc },
    { ...MUTATE, title: "Delete document" },
    async ({ db, collection, filter }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .deleteOne(parseExtendedJson<Document>(filter));
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "deleteMany",
    "Delete documents matching the filter. Refuses an empty filter; pass {} explicitly to wipe the collection.",
    {
      ...collArg,
      filter: jsonDoc,
      confirm: z
        .boolean()
        .default(false)
        .describe("Must be true when filter is empty / matches all documents."),
    },
    { ...MUTATE, title: "Delete documents" },
    async ({ db, collection, filter, confirm }) => {
      try {
        const parsed = parseExtendedJson<Document>(filter);
        const isEmpty = !parsed || Object.keys(parsed).length === 0;
        if (isEmpty && !confirm) {
          throw new Error(
            "Refusing to deleteMany with an empty filter. Re-call with confirm: true to delete all documents.",
          );
        }
        const client = await getClient();
        const result = await client.db(db).collection(collection).deleteMany(parsed);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- admin / DDL ----------

  tool(
    "createCollection",
    "Create a new collection.",
    { ...collArg, options: jsonDoc.optional() },
    { ...ADD, title: "Create collection" },
    async ({ db, collection, options }) => {
      try {
        const client = await getClient();
        await client
          .db(db)
          .createCollection(collection, options ? parseExtendedJson<Document>(options) : undefined);
        return ok({ ok: 1, db, collection });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dropCollection",
    "Drop a collection. Requires confirm: true.",
    { ...collArg, confirm: z.literal(true) },
    { ...MUTATE, title: "Drop collection" },
    async ({ db, collection }) => {
      try {
        const client = await getClient();
        const dropped = await client.db(db).collection(collection).drop();
        return ok({ dropped, db, collection });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "renameCollection",
    "Rename a collection.",
    {
      ...collArg,
      target: z.string().min(1).describe("New collection name."),
      dropTarget: z.boolean().default(false),
    },
    { ...MUTATE, title: "Rename collection" },
    async ({ db, collection, target, dropTarget }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).collection(collection).rename(target, { dropTarget });
        return ok({ ok: 1, db, from: collection, to: result.collectionName });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "createIndex",
    "Create an index.",
    {
      ...collArg,
      keys: jsonDoc.describe('Index keys, e.g. {"email": 1}'),
      options: jsonDoc.optional(),
    },
    { ...ADD, idempotentHint: true, title: "Create index" },
    async ({ db, collection, keys, options }) => {
      try {
        const client = await getClient();
        const name = await client
          .db(db)
          .collection(collection)
          .createIndex(
            parseExtendedJson<Document>(keys),
            options ? parseExtendedJson<Document>(options) : undefined,
          );
        return ok({ name });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "listIndexes",
    "List indexes on a collection.",
    { ...collArg },
    { ...READ, title: "List indexes" },
    async ({ db, collection }) => {
      try {
        const client = await getClient();
        const idx = await client.db(db).collection(collection).indexes();
        return ok(idx);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dropIndex",
    "Drop an index by name.",
    { ...collArg, indexName: z.string().min(1) },
    { ...MUTATE, title: "Drop index" },
    async ({ db, collection, indexName }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).collection(collection).dropIndex(indexName);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "createIndexes",
    "Create several indexes on a collection in one command, so the collection is scanned once instead of once per index.",
    {
      ...collArg,
      indexes: jsonArray.describe(
        'Index specs, each needing key and name, e.g. [{"key": {"email": 1}, "name": "email_1", "unique": true}].',
      ),
    },
    { ...ADD, idempotentHint: true, title: "Create indexes" },
    async ({ db, collection, indexes }) => {
      try {
        const specs = parseExtendedJson<Document[]>(indexes);
        if (!Array.isArray(specs)) throw new Error("indexes must be an array");
        const client = await getClient();
        const result = await client.db(db).command({ createIndexes: collection, indexes: specs });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dropIndexes",
    "Drop every index on a collection except the mandatory _id index. Requires confirm: true.",
    { ...collArg, confirm: z.literal(true) },
    { ...MUTATE, title: "Drop all indexes" },
    async ({ db, collection }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({ dropIndexes: collection, index: "*" });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "hideIndex",
    "Hide an index from the query planner without dropping it — the safe way to test whether an index is still needed before dropping it. Reverse with unhideIndex.",
    { ...collArg, indexName: z.string().min(1) },
    { ...MUTATE, idempotentHint: true, title: "Hide index" },
    async ({ db, collection, indexName }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .command({ collMod: collection, index: { name: indexName, hidden: true } });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "unhideIndex",
    "Return a hidden index to the query planner.",
    { ...collArg, indexName: z.string().min(1) },
    { ...ADD, idempotentHint: true, title: "Unhide index" },
    async ({ db, collection, indexName }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .command({ collMod: collection, index: { name: indexName, hidden: false } });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "runCommand",
    "Run an arbitrary database command. Use sparingly. User and role administration commands are refused — see the note on identity management in the README.",
    { ...dbArg, command: jsonDoc },
    { ...MUTATE, openWorldHint: true, title: "Run database command" },
    async ({ db, command }) => {
      try {
        const cmd = parseExtendedJson<Document>(command);
        assertNotIdentityCommand(cmd);
        const client = await getClient();
        const result = await client.db(db).command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool("ping", "Ping the cluster.", {}, { ...READ, title: "Ping cluster" }, async () => {
    try {
      const client = await getClient();
      const result = await client.db("admin").command({ ping: 1 });
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  });

  // ---------- read helpers ----------

  tool(
    "distinct",
    "Return the distinct values for a field across a collection.",
    {
      ...collArg,
      field: z.string().min(1).describe("Field name to compute distinct values for."),
      filter: jsonDoc.optional(),
    },
    { ...READ, title: "Distinct values" },
    async ({ db, collection, field, filter }) => {
      try {
        const client = await getClient();
        const values = await client
          .db(db)
          .collection(collection)
          .distinct(field, filter ? parseExtendedJson<Document>(filter) : {});
        return ok({ count: values.length, values });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "estimatedDocumentCount",
    "Fast collection-cardinality estimate from collection metadata (no filter).",
    { ...collArg },
    { ...READ, title: "Estimated document count" },
    async ({ db, collection }) => {
      try {
        const client = await getClient();
        const count = await client.db(db).collection(collection).estimatedDocumentCount();
        return ok({ count });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "explain",
    "Run db.command({ explain: <command>, verbosity }) to get a query plan.",
    {
      ...dbArg,
      command: jsonDoc.describe(
        'Command to explain, e.g. {"find": "users", "filter": {"age": {"$gt": 21}}}.',
      ),
      verbosity: z
        .enum(["queryPlanner", "executionStats", "allPlansExecution"])
        .default("queryPlanner"),
    },
    { ...READ, title: "Explain query plan" },
    async ({ db, command, verbosity }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .command({ explain: parseExtendedJson<Document>(command), verbosity });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- atomic write helpers ----------

  tool(
    "replaceOne",
    "Replace a single document matching the filter.",
    {
      ...collArg,
      filter: jsonDoc,
      replacement: jsonDoc,
      upsert: z.boolean().default(false),
    },
    { ...MUTATE, title: "Replace document" },
    async ({ db, collection, filter, replacement, upsert }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .replaceOne(
            parseExtendedJson<Document>(filter),
            parseExtendedJson<Document>(replacement),
            { upsert },
          );
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "findOneAndUpdate",
    "Atomically update one document and return it.",
    {
      ...collArg,
      filter: jsonDoc,
      update: jsonDoc.describe("Update document or pipeline. Use operators like $set."),
      projection: jsonDoc.optional(),
      sort: jsonDoc.optional(),
      upsert: z.boolean().default(false),
      returnDocument: z.enum(["before", "after"]).default("after"),
    },
    { ...MUTATE, title: "Find and update" },
    async ({ db, collection, filter, update, projection, sort, upsert, returnDocument }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .findOneAndUpdate(
            parseExtendedJson<Document>(filter),
            parseExtendedJson<Document>(update),
            {
              projection: projection ? parseExtendedJson<Document>(projection) : undefined,
              sort: sort ? parseExtendedJson<Document>(sort) : undefined,
              upsert,
              returnDocument,
              includeResultMetadata: true,
            },
          );
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "findOneAndReplace",
    "Atomically replace one document and return it.",
    {
      ...collArg,
      filter: jsonDoc,
      replacement: jsonDoc,
      projection: jsonDoc.optional(),
      sort: jsonDoc.optional(),
      upsert: z.boolean().default(false),
      returnDocument: z.enum(["before", "after"]).default("after"),
    },
    { ...MUTATE, title: "Find and replace" },
    async ({ db, collection, filter, replacement, projection, sort, upsert, returnDocument }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .findOneAndReplace(
            parseExtendedJson<Document>(filter),
            parseExtendedJson<Document>(replacement),
            {
              projection: projection ? parseExtendedJson<Document>(projection) : undefined,
              sort: sort ? parseExtendedJson<Document>(sort) : undefined,
              upsert,
              returnDocument,
              includeResultMetadata: true,
            },
          );
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "findOneAndDelete",
    "Atomically delete one document and return it.",
    {
      ...collArg,
      filter: jsonDoc,
      projection: jsonDoc.optional(),
      sort: jsonDoc.optional(),
    },
    { ...MUTATE, title: "Find and delete" },
    async ({ db, collection, filter, projection, sort }) => {
      try {
        const client = await getClient();
        const result = await client
          .db(db)
          .collection(collection)
          .findOneAndDelete(parseExtendedJson<Document>(filter), {
            projection: projection ? parseExtendedJson<Document>(projection) : undefined,
            sort: sort ? parseExtendedJson<Document>(sort) : undefined,
            includeResultMetadata: true,
          });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "bulkWrite",
    "Run a bulkWrite() with insertOne/updateOne/updateMany/replaceOne/deleteOne/deleteMany operations.",
    {
      ...collArg,
      operations: jsonArray.describe(
        'Array of bulk operations, e.g. [{"insertOne": {"document": {...}}}, {"updateOne": {"filter": {...}, "update": {"$set": {...}}}}].',
      ),
      ordered: z.boolean().default(true),
    },
    { ...MUTATE, title: "Bulk write" },
    async ({ db, collection, operations, ordered }) => {
      try {
        const client = await getClient();
        const ops = parseExtendedJson<Document[]>(operations);
        if (!Array.isArray(ops)) throw new Error("operations must be an array");
        const result = await client
          .db(db)
          .collection(collection)
          .bulkWrite(ops as AnyBulkWriteOperation<Document>[], { ordered });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- views & Atlas Search ----------

  tool(
    "createView",
    "Create a read-only view backed by an aggregation pipeline on a source collection.",
    {
      ...dbArg,
      view: z.string().min(1).describe("Name of the view to create."),
      viewOn: z.string().min(1).describe("Source collection the view reads from."),
      pipeline: jsonArray.describe("Aggregation pipeline that defines the view."),
    },
    { ...ADD, title: "Create view" },
    async ({ db, view, viewOn, pipeline }) => {
      try {
        const stages = parseExtendedJson<Document[]>(pipeline);
        if (!Array.isArray(stages)) throw new Error("pipeline must be an array of stages");
        const client = await getClient();
        await client.db(db).createCollection(view, { viewOn, pipeline: stages });
        return ok({ ok: 1, db, view, viewOn });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "listSearchIndexes",
    "List Atlas Search indexes on a collection.",
    { ...collArg, name: z.string().optional().describe("Filter to a single index name.") },
    { ...READ, title: "List search indexes" },
    async ({ db, collection, name }) => {
      try {
        const client = await getClient();
        const coll = client.db(db).collection(collection);
        const cursor = name ? coll.listSearchIndexes(name) : coll.listSearchIndexes();
        const indexes = await cursor.toArray();
        return ok(indexes);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "createSearchIndex",
    "Create an Atlas Search index. Requires an Atlas cluster.",
    {
      ...collArg,
      name: z.string().min(1).describe("Index name."),
      definition: jsonDoc.describe("Search index definition (mappings, analyzers, etc.)."),
      type: z.enum(["search", "vectorSearch"]).default("search"),
    },
    { ...ADD, title: "Create search index" },
    async ({ db, collection, name, definition, type }) => {
      try {
        const client = await getClient();
        const createdName = await client
          .db(db)
          .collection(collection)
          .createSearchIndex({
            name,
            type,
            definition: parseExtendedJson<Document>(definition),
          });
        return ok({ name: createdName });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "updateSearchIndex",
    "Update an Atlas Search index definition.",
    {
      ...collArg,
      name: z.string().min(1),
      definition: jsonDoc,
    },
    { ...MUTATE, title: "Update search index" },
    async ({ db, collection, name, definition }) => {
      try {
        const client = await getClient();
        await client
          .db(db)
          .collection(collection)
          .updateSearchIndex(name, parseExtendedJson<Document>(definition));
        return ok({ ok: 1, name });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dropSearchIndex",
    "Drop an Atlas Search index by name.",
    { ...collArg, name: z.string().min(1) },
    { ...MUTATE, title: "Drop search index" },
    async ({ db, collection, name }) => {
      try {
        const client = await getClient();
        await client.db(db).collection(collection).dropSearchIndex(name);
        return ok({ ok: 1, name });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- database admin ----------

  tool(
    "dropDatabase",
    "Drop an entire database and all its collections. Requires confirm: true. Irreversible.",
    { ...dbArg, confirm: z.literal(true) },
    { ...MUTATE, title: "Drop database" },
    async ({ db }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).dropDatabase();
        return ok({ dropped: result, db });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "collMod",
    "Modify collection options: JSON Schema validator, validationAction, changeStreamPreAndPostImages, or hide/unhide an index.",
    {
      ...collArg,
      options: jsonDoc.describe(
        'Modification doc, e.g. {"validator": {"$jsonSchema": {...}}, "validationAction": "warn"} or {"index": {"name": "myIdx", "hidden": true}}.',
      ),
    },
    { ...MUTATE, title: "Modify collection" },
    async ({ db, collection, options }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({
          collMod: collection,
          ...parseExtendedJson<Document>(options),
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "validate",
    "Validate a collection's internal structure and indexes. Non-destructive by default.",
    {
      ...collArg,
      full: z
        .boolean()
        .default(false)
        .describe("Full validation — thorough but slow on large collections."),
    },
    { ...READ, title: "Validate collection" },
    async ({ db, collection, full }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({ validate: collection, full });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dataSize",
    "Measure the size in bytes of a collection, or of one key range within it. Unlike collStats this reads the documents, so it is slow on large collections.",
    {
      ...collArg,
      keyPattern: jsonDoc
        .optional()
        .describe(
          'Index key pattern the range is expressed in, e.g. {"_id": 1}. Required with min/max.',
        ),
      min: jsonDoc.optional().describe("Inclusive lower bound of the key range."),
      max: jsonDoc.optional().describe("Exclusive upper bound of the key range."),
      estimate: z
        .boolean()
        .default(false)
        .describe("Use average document size instead of reading every document."),
    },
    { ...READ, title: "Data size" },
    async ({ db, collection, keyPattern, min, max, estimate }) => {
      try {
        const cmd: Document = { dataSize: `${db}.${collection}`, estimate };
        if (keyPattern) cmd.keyPattern = parseExtendedJson<Document>(keyPattern);
        if (min) cmd.min = parseExtendedJson<Document>(min);
        if (max) cmd.max = parseExtendedJson<Document>(max);
        const client = await getClient();
        const result = await client.db(db).command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "dbHash",
    "Return an md5 checksum per collection for a database. Comparing hashes across environments shows which collections actually differ.",
    {
      ...dbArg,
      collections: z
        .array(z.string().min(1))
        .optional()
        .describe("Limit the hash to these collections. Omit to hash all of them."),
    },
    { ...READ, title: "Database hash" },
    async ({ db, collections }) => {
      try {
        const cmd: Document = { dbHash: 1 };
        if (collections?.length) cmd.collections = collections;
        const client = await getClient();
        const result = await client.db(db).command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "convertToCapped",
    "Convert a collection to a capped collection of a fixed size, dropping the oldest documents once it is full. Requires confirm: true — this rewrites the collection and drops its non-_id indexes.",
    {
      ...collArg,
      size: z.number().int().min(1).describe("Maximum size of the capped collection in bytes."),
      confirm: z.literal(true),
    },
    { ...MUTATE, title: "Convert to capped" },
    async ({ db, collection, size }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({ convertToCapped: collection, size });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- monitoring ----------

  tool(
    "serverStatus",
    "Return server status: connections, opcounters, memory, replication state. Excludes bulky wiredTiger/tcmalloc sections by default.",
    {
      includeAll: z
        .boolean()
        .default(false)
        .describe("Include all sections (wiredTiger, tcmalloc, locks). Output can be very large."),
    },
    { ...READ, title: "Server status" },
    async ({ includeAll }) => {
      try {
        const client = await getClient();
        const cmd: Document = { serverStatus: 1 };
        if (!includeAll) {
          cmd.wiredTiger = 0;
          cmd.tcmalloc = 0;
          cmd.locks = 0;
          cmd.logicalSessionRecordCache = 0;
          cmd.twoPhaseCommitCoordinator = 0;
        }
        const result = await client.db("admin").command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "hostInfo",
    "Return MongoDB version, OS, and hardware information.",
    {},
    { ...READ, title: "Host info" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ hostInfo: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "buildInfo",
    "Return the MongoDB server version and build details. Use this to check whether a feature or command is available on the cluster; hostInfo covers the OS and hardware instead.",
    {},
    { ...READ, title: "Build info" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ buildInfo: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "connectionStatus",
    "Show which user the MCP is authenticated as and the roles and privileges that user holds. Start here when a tool returns 'not authorized'.",
    {
      showPrivileges: z
        .boolean()
        .default(true)
        .describe("Include the resolved privilege list, not just role names."),
    },
    { ...READ, title: "Connection status" },
    async ({ showPrivileges }) => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ connectionStatus: 1, showPrivileges });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "listCommands",
    "List the database commands this cluster accepts. Useful for checking whether a command exists before calling runCommand, since managed tiers disable some of them.",
    {},
    { ...READ, title: "List commands" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ listCommands: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "getLog",
    "Fetch recent in-memory server log lines. 'startupWarnings' surfaces configuration problems; 'global' is the general ring buffer.",
    {
      log: z
        .enum(["global", "startupWarnings", "rs"])
        .default("global")
        .describe("Which in-memory log to read."),
    },
    { ...READ, title: "Get server log" },
    async ({ log }) => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ getLog: log });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "top",
    "Per-collection time spent on reads and writes since the last restart. Points at which collections carry the load. Not available on sharded clusters via mongos.",
    {},
    { ...READ, title: "Collection usage (top)" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ top: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "connPoolStats",
    "Connection-pool statistics for the server's outgoing connections. Useful when diagnosing connection exhaustion.",
    {},
    { ...READ, title: "Connection pool stats" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ connPoolStats: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "currentOp",
    "Show currently-running operations. Useful for diagnosing long-running queries or locks.",
    {
      filter: jsonDoc
        .optional()
        .describe(
          'Optional filter, e.g. {"active": true} or {"op": "query", "secs_running": {"$gt": 5}}.',
        ),
    },
    { ...READ, title: "Current operations" },
    async ({ filter }) => {
      try {
        const client = await getClient();
        const cmd: Document = { currentOp: 1 };
        if (filter) Object.assign(cmd, parseExtendedJson<Document>(filter));
        const result = await client.db("admin").command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "killOp",
    "Kill a running operation by its opId (from currentOp). Use with caution — may leave write operations partially applied.",
    { opId: z.number().int().describe("Operation id from currentOp.inprog[].opid.") },
    { ...MUTATE, title: "Kill operation" },
    async ({ opId }) => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ killOp: 1, op: opId });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- replication & sharding ----------

  tool(
    "replSetGetStatus",
    "Replica set health: member states, election term, and replication lag via each member's optime.",
    {},
    { ...READ, title: "Replica set status" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ replSetGetStatus: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "listShards",
    "List the shards in a sharded cluster. Errors on a plain replica set, which has no shards.",
    {},
    { ...READ, title: "List shards" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ listShards: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "balancerStatus",
    "Report whether the sharded-cluster balancer is enabled and currently running.",
    {},
    { ...READ, title: "Balancer status" },
    async () => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ balancerStatus: 1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "enableSharding",
    "Enable sharding on a database. Requires confirm: true — a database cannot be un-sharded afterwards.",
    { ...dbArg, confirm: z.literal(true) },
    { ...MUTATE, title: "Enable sharding" },
    async ({ db }) => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({ enableSharding: db });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "shardCollection",
    "Shard a collection on a shard key. Requires confirm: true — the choice of shard key is permanent and drives every later query's performance.",
    {
      ...collArg,
      key: jsonDoc.describe('Shard key, e.g. {"tenantId": 1} or {"userId": "hashed"}.'),
      unique: z.boolean().default(false).describe("Enforce uniqueness on the shard key."),
      confirm: z.literal(true),
    },
    { ...MUTATE, title: "Shard collection" },
    async ({ db, collection, key, unique }) => {
      try {
        const client = await getClient();
        const result = await client.db("admin").command({
          shardCollection: `${db}.${collection}`,
          key: parseExtendedJson<Document>(key),
          unique,
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------- profiling ----------

  tool(
    "getProfilingStatus",
    "Return the current slow-query profiling level and slowms threshold for a database.",
    { ...dbArg },
    { ...READ, title: "Get profiling status" },
    async ({ db }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({ profile: -1 });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "setProfilingLevel",
    "Set slow-query profiling: 0 = off, 1 = slow ops (above slowms), 2 = all ops.",
    {
      ...dbArg,
      level: z.number().int().min(0).max(2).describe("0 = off, 1 = slow ops, 2 = all ops."),
      slowms: z
        .number()
        .int()
        .min(-1)
        .optional()
        .describe("Threshold in milliseconds for level 1 (default 100)."),
      sampleRate: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Fraction of slow ops to profile, 0.0–1.0."),
    },
    { ...MUTATE, title: "Set profiling level" },
    async ({ db, level, slowms, sampleRate }) => {
      try {
        const client = await getClient();
        const cmd: Document = { profile: level };
        if (slowms !== undefined) cmd.slowms = slowms;
        if (sampleRate !== undefined) cmd.sampleRate = sampleRate;
        const result = await client.db(db).command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "getProfilingData",
    "Fetch recent entries from system.profile (slow-query log). Requires profiling level ≥ 1.",
    {
      ...dbArg,
      filter: jsonDoc.optional().describe('e.g. {"ns": "mydb.users", "millis": {"$gt": 500}}.'),
      limit: z.number().int().min(1).max(100).default(20),
    },
    { ...READ, title: "Get profiling data" },
    async ({ db, filter, limit }) => {
      try {
        const client = await getClient();
        const docs = await client
          .db(db)
          .collection("system.profile")
          .find(filter ? parseExtendedJson<Document>(filter) : {}, { sort: { ts: -1 }, limit })
          .toArray();
        return ok({ count: docs.length, documents: docs });
      } catch (e) {
        return fail(e);
      }
    },
  );

  tool(
    "indexStats",
    "Return $indexStats for a collection — per-index usage counts since the last mongod restart.",
    { ...collArg },
    { ...READ, title: "Index stats" },
    async ({ db, collection }) => {
      try {
        const client = await getClient();
        const docs = await client
          .db(db)
          .collection(collection)
          .aggregate([{ $indexStats: {} }])
          .toArray();
        return ok({ count: docs.length, indexes: docs });
      } catch (e) {
        return fail(e);
      }
    },
  );
}

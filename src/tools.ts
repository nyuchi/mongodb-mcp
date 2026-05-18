import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnyBulkWriteOperation, Document, MongoClient } from "mongodb";
import { z } from "zod";
import { parseExtendedJson, stringifyEJson } from "./mongo";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: stringifyEJson(value) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
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

export function registerMongoTools(server: McpServer, getClient: () => Promise<MongoClient>) {
  // ---------- discovery ----------

  server.tool(
    "listDatabases",
    "List databases on the cluster with their size on disk.",
    {},
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

  server.tool(
    "listCollections",
    "List collections in a database.",
    { ...dbArg },
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

  server.tool("dbStats", "Return db.stats() for a database.", { ...dbArg }, async ({ db }) => {
    try {
      const client = await getClient();
      const stats = await client.db(db).stats();
      return ok(stats);
    } catch (e) {
      return fail(e);
    }
  });

  server.tool(
    "collStats",
    "Return collStats for a collection (via $collStats aggregation).",
    { ...collArg },
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

  server.tool(
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

  server.tool(
    "findOne",
    "Return a single document.",
    {
      ...collArg,
      filter: jsonDoc.optional(),
      projection: jsonDoc.optional(),
    },
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

  server.tool(
    "count",
    "Count documents matching a filter (countDocuments).",
    { ...collArg, filter: jsonDoc.optional() },
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

  server.tool(
    "aggregate",
    "Run an aggregation pipeline.",
    {
      ...collArg,
      pipeline: jsonArray,
      limit: z.number().int().min(1).max(1000).default(100),
    },
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

  server.tool(
    "insertOne",
    "Insert a single document.",
    { ...collArg, document: jsonDoc },
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

  server.tool(
    "insertMany",
    "Insert multiple documents.",
    { ...collArg, documents: jsonArray, ordered: z.boolean().default(true) },
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

  server.tool(
    "updateOne",
    "Update a single document.",
    {
      ...collArg,
      filter: jsonDoc,
      update: jsonDoc.describe("Update document or pipeline. Use operators like $set."),
      upsert: z.boolean().default(false),
    },
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

  server.tool(
    "updateMany",
    "Update many documents.",
    {
      ...collArg,
      filter: jsonDoc,
      update: jsonDoc,
      upsert: z.boolean().default(false),
    },
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

  server.tool(
    "deleteOne",
    "Delete a single document matching the filter.",
    { ...collArg, filter: jsonDoc },
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

  server.tool(
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

  server.tool(
    "createCollection",
    "Create a new collection.",
    { ...collArg, options: jsonDoc.optional() },
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

  server.tool(
    "dropCollection",
    "Drop a collection. Requires confirm: true.",
    { ...collArg, confirm: z.literal(true) },
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

  server.tool(
    "renameCollection",
    "Rename a collection.",
    {
      ...collArg,
      target: z.string().min(1).describe("New collection name."),
      dropTarget: z.boolean().default(false),
    },
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

  server.tool(
    "createIndex",
    "Create an index.",
    {
      ...collArg,
      keys: jsonDoc.describe('Index keys, e.g. {"email": 1}'),
      options: jsonDoc.optional(),
    },
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

  server.tool(
    "listIndexes",
    "List indexes on a collection.",
    { ...collArg },
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

  server.tool(
    "dropIndex",
    "Drop an index by name.",
    { ...collArg, indexName: z.string().min(1) },
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

  server.tool(
    "runCommand",
    "Run an arbitrary database command. Use sparingly.",
    { ...dbArg, command: jsonDoc },
    async ({ db, command }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command(parseExtendedJson<Document>(command));
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool("ping", "Ping the cluster.", {}, async () => {
    try {
      const client = await getClient();
      const result = await client.db("admin").command({ ping: 1 });
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  });

  // ---------- read helpers ----------

  server.tool(
    "distinct",
    "Return the distinct values for a field across a collection.",
    {
      ...collArg,
      field: z.string().min(1).describe("Field name to compute distinct values for."),
      filter: jsonDoc.optional(),
    },
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

  server.tool(
    "estimatedDocumentCount",
    "Fast collection-cardinality estimate from collection metadata (no filter).",
    { ...collArg },
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

  server.tool(
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

  server.tool(
    "replaceOne",
    "Replace a single document matching the filter.",
    {
      ...collArg,
      filter: jsonDoc,
      replacement: jsonDoc,
      upsert: z.boolean().default(false),
    },
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

  server.tool(
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

  server.tool(
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

  server.tool(
    "findOneAndDelete",
    "Atomically delete one document and return it.",
    {
      ...collArg,
      filter: jsonDoc,
      projection: jsonDoc.optional(),
      sort: jsonDoc.optional(),
    },
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

  server.tool(
    "bulkWrite",
    "Run a bulkWrite() with insertOne/updateOne/updateMany/replaceOne/deleteOne/deleteMany operations.",
    {
      ...collArg,
      operations: jsonArray.describe(
        'Array of bulk operations, e.g. [{"insertOne": {"document": {...}}}, {"updateOne": {"filter": {...}, "update": {"$set": {...}}}}].',
      ),
      ordered: z.boolean().default(true),
    },
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

  server.tool(
    "createView",
    "Create a read-only view backed by an aggregation pipeline on a source collection.",
    {
      ...dbArg,
      view: z.string().min(1).describe("Name of the view to create."),
      viewOn: z.string().min(1).describe("Source collection the view reads from."),
      pipeline: jsonArray.describe("Aggregation pipeline that defines the view."),
    },
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

  server.tool(
    "listSearchIndexes",
    "List Atlas Search indexes on a collection.",
    { ...collArg, name: z.string().optional().describe("Filter to a single index name.") },
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

  server.tool(
    "createSearchIndex",
    "Create an Atlas Search index. Requires an Atlas cluster.",
    {
      ...collArg,
      name: z.string().min(1).describe("Index name."),
      definition: jsonDoc.describe("Search index definition (mappings, analyzers, etc.)."),
      type: z.enum(["search", "vectorSearch"]).default("search"),
    },
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

  server.tool(
    "updateSearchIndex",
    "Update an Atlas Search index definition.",
    {
      ...collArg,
      name: z.string().min(1),
      definition: jsonDoc,
    },
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

  server.tool(
    "dropSearchIndex",
    "Drop an Atlas Search index by name.",
    { ...collArg, name: z.string().min(1) },
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

  // ---------- user / role management ----------
  // These wrap the underlying database commands. Caller must be authenticated with
  // sufficient privileges on the target database (typically userAdmin or root).

  const roleArg = z
    .union([z.string(), z.array(z.union([z.string(), z.record(z.string(), z.unknown())]))])
    .describe(
      'Role name or array of role specs. e.g. ["read"] or [{"role": "readWrite", "db": "app"}].',
    );

  server.tool(
    "createUser",
    "Create a database user (db.command({ createUser, pwd, roles })).",
    {
      ...dbArg,
      user: z.string().min(1).describe("Username to create."),
      pwd: z.string().min(1).describe("Password for the new user."),
      roles: roleArg,
      customData: jsonDoc.optional(),
    },
    async ({ db, user, pwd, roles, customData }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({
          createUser: user,
          pwd,
          roles: Array.isArray(roles) ? roles : [roles],
          ...(customData ? { customData: parseExtendedJson<Document>(customData) } : {}),
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "updateUser",
    "Update a database user. Any of pwd / roles / customData can be changed.",
    {
      ...dbArg,
      user: z.string().min(1),
      pwd: z.string().optional(),
      roles: roleArg.optional(),
      customData: jsonDoc.optional(),
    },
    async ({ db, user, pwd, roles, customData }) => {
      try {
        const client = await getClient();
        const cmd: Document = { updateUser: user };
        if (pwd !== undefined) cmd.pwd = pwd;
        if (roles !== undefined) cmd.roles = Array.isArray(roles) ? roles : [roles];
        if (customData !== undefined) cmd.customData = parseExtendedJson<Document>(customData);
        const result = await client.db(db).command(cmd);
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "dropUser",
    "Drop a database user. Requires confirm: true.",
    { ...dbArg, user: z.string().min(1), confirm: z.literal(true) },
    async ({ db, user }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({ dropUser: user });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "grantRolesToUser",
    "Grant roles to an existing user.",
    { ...dbArg, user: z.string().min(1), roles: roleArg },
    async ({ db, user, roles }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({
          grantRolesToUser: user,
          roles: Array.isArray(roles) ? roles : [roles],
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    "revokeRolesFromUser",
    "Revoke roles from an existing user.",
    { ...dbArg, user: z.string().min(1), roles: roleArg },
    async ({ db, user, roles }) => {
      try {
        const client = await getClient();
        const result = await client.db(db).command({
          revokeRolesFromUser: user,
          roles: Array.isArray(roles) ? roles : [roles],
        });
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    },
  );
}

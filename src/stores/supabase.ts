import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Access } from "../scopes";
import { MUTATE, READ, confirmArg, limitArg, toolDefiner } from "./common";

// The Supabase projects the data MCP knows about. `envKey` names the worker
// secrets: SUPABASE_<envKey>_RO_URL (the read-only role, always used for
// reads) and SUPABASE_<envKey>_RW_URL (optional; only write tools use it, and
// without it they refuse).
export const SUPABASE_PROJECTS = {
  nyuchi_relational_db: { ref: "ponbvierjjqsbvvkkafl", envKey: "RELATIONAL" },
  nyuchi_pay_db: { ref: undefined, envKey: "PAY" },
  shamwari_ai_db: { ref: undefined, envKey: "SHAMWARI" },
  mzizi_db: { ref: undefined, envKey: "MZIZI" },
} as const;

export type SupabaseProject = keyof typeof SUPABASE_PROJECTS;
const projectNames = Object.keys(SUPABASE_PROJECTS) as [SupabaseProject, ...SupabaseProject[]];

export interface SqlResult {
  rows: unknown[];
  truncated: boolean;
}

export interface SqlRunner {
  run(
    project: SupabaseProject,
    access: Access,
    sql: string,
    params: readonly unknown[],
    maxRows: number,
  ): Promise<SqlResult>;
  configured(project: SupabaseProject): { read: boolean; write: boolean };
}

// A convenience check so an obvious write sent to the read tool gets a clear
// message. It is not the boundary: reads run as a role with SELECT only,
// inside a READ ONLY transaction, over the extended protocol (one statement).
const READ_SHAPED = /^\s*(select|with|explain|show|values|table)\b/i;

export function assertReadShaped(sql: string): void {
  if (!READ_SHAPED.test(sql)) {
    throw new Error(
      "supabase_query runs read-only statements (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE). Use supabase_execute, which needs supabase:write, for anything else.",
    );
  }
}

const projectArg = {
  project: z.enum(projectNames).describe("Supabase project (database) to use."),
};
const paramsArg = {
  params: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .default([])
    .describe("Positional parameters for $1, $2, … in the statement."),
};

export function registerSupabaseTools(server: McpServer, sql: SqlRunner): void {
  const tool = toolDefiner(server);

  tool(
    "listProjects",
    "List the Supabase projects this server knows, and whether read and write credentials are configured for each.",
    {},
    { ...READ, title: "List Supabase projects" },
    async () =>
      projectNames.map((project) => ({
        project,
        ref: SUPABASE_PROJECTS[project].ref ?? null,
        ...sql.configured(project),
      })),
  );

  tool(
    "listTables",
    "List tables and views in one schema of a Supabase project.",
    {
      ...projectArg,
      schema: z.string().min(1).default("public").describe("Schema name."),
    },
    { ...READ, title: "List tables" },
    async ({ project, schema }) =>
      sql.run(
        project,
        "read",
        "select table_name, table_type from information_schema.tables where table_schema = $1 order by table_name",
        [schema],
        1000,
      ),
  );

  tool(
    "describeTable",
    "Describe a table's columns (name, type, nullability, default) in a Supabase project.",
    {
      ...projectArg,
      schema: z.string().min(1).default("public").describe("Schema name."),
      table: z.string().min(1).describe("Table name."),
    },
    { ...READ, title: "Describe table" },
    async ({ project, schema, table }) =>
      sql.run(
        project,
        "read",
        "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
        [schema, table],
        1000,
      ),
  );

  tool(
    "query",
    "Run one read-only SQL statement against a Supabase project as the read-only role. Results are capped at `limit` rows.",
    {
      ...projectArg,
      sql: z.string().min(1).describe("One SQL statement."),
      ...paramsArg,
      ...limitArg,
    },
    { ...READ, title: "Read-only SQL query" },
    async ({ project, sql: statement, params, limit }) => {
      assertReadShaped(statement);
      return sql.run(project, "read", statement, params, limit);
    },
  );

  tool(
    "execute",
    "Run one SQL statement that may change data, as the project's read-write role. Needs supabase:write and a configured write credential.",
    {
      ...projectArg,
      sql: z.string().min(1).describe("One SQL statement."),
      ...paramsArg,
      ...confirmArg,
    },
    { ...MUTATE, title: "Execute SQL (write)" },
    async ({ project, sql: statement, params }) =>
      sql.run(project, "write", statement, params, 1000),
  );
}

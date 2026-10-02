import type { Access } from "../scopes";
import {
  SUPABASE_PROJECTS,
  type SqlResult,
  type SqlRunner,
  type SupabaseProject,
} from "./supabase";

type Env = Record<string, unknown>;
type Sql = import("postgres").Sql;

function secretName(project: SupabaseProject, access: Access): string {
  return `SUPABASE_${SUPABASE_PROJECTS[project].envKey}_${access === "read" ? "RO" : "RW"}_URL`;
}

function urlFor(env: Env, project: SupabaseProject, access: Access): string | undefined {
  const value = env[secretName(project, access)];
  return typeof value === "string" && value.trim() ? value : undefined;
}

// One pool per connection string per isolate, created lazily inside a request
// (workerd refuses sockets at module scope). `postgres` is imported dynamically
// so modules the tests load never pull the driver in.
const pools = new Map<string, Promise<Sql>>();

function pool(url: string): Promise<Sql> {
  let existing = pools.get(url);
  if (!existing) {
    existing = import("postgres").then(({ default: postgres }) =>
      postgres(url, {
        // Supavisor in transaction mode (port 6543) cannot hold prepared statements.
        prepare: false,
        max: 2,
        idle_timeout: 20,
        connect_timeout: 10,
        connection: { application_name: "nyuchi-data-mcp" },
      }),
    );
    existing.catch(() => pools.delete(url));
    pools.set(url, existing);
  }
  return existing;
}

export function postgresRunner(env: Env): SqlRunner {
  return {
    configured(project) {
      return {
        read: Boolean(urlFor(env, project, "read")),
        write: Boolean(urlFor(env, project, "write")),
      };
    },

    async run(project, access, statement, params, maxRows): Promise<SqlResult> {
      const url = urlFor(env, project, access);
      if (!url) {
        throw new Error(
          `${secretName(project, access)} is not set on this worker, so ${access} access to ${project} is unavailable.`,
        );
      }
      const sql = await pool(url);
      const mode = access === "read" ? "read only" : "read write";
      // simple: false forces the extended protocol even with no parameters
      // (postgres.js defaults to the simple one then). The extended protocol
      // accepts exactly one statement, so "COMMIT; DELETE …" cannot escape the
      // READ ONLY transaction.
      const rows = (await sql.begin(mode, async (tx) => {
        await tx.unsafe("set local statement_timeout = '15s'");
        return tx.unsafe(statement, params as never[], { simple: false } as never);
      })) as unknown as unknown[];
      return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
    },
  };
}

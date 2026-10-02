// Every operation the relay will perform, which store it touches, whether it
// can change data, and how to run it. Anything not in this table is refused.
//
// The op names mirror the Worker's tools (src/stores/private.ts); the relay
// test reads that file and fails if the two lists drift.

export type Store = "doris" | "cassandra" | "graph";
export type Access = "read" | "write";

export interface Rows {
  rows: unknown[];
  truncated: boolean;
}

export interface DorisBackend {
  callTool(tool: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface CassandraBackend {
  execute(access: Access, cql: string, params: unknown[], limit: number): Promise<Rows>;
}

export interface GraphBackend {
  summary(): Promise<unknown>;
  findVertices(
    label: string | undefined,
    has: Record<string, unknown>,
    limit: number,
  ): Promise<unknown>;
  neighbours(
    vertexId: string | number,
    direction: "out" | "in" | "both",
    edgeLabel: string | undefined,
    limit: number,
  ): Promise<unknown>;
  evaluate(script: string, bindings: Record<string, unknown>): Promise<unknown>;
}

export interface Backends {
  doris: DorisBackend;
  cassandra: CassandraBackend;
  graph: GraphBackend;
}

export interface OpSpec {
  store: Store;
  access: Access;
  run(backends: Backends, args: Record<string, unknown>): Promise<unknown>;
}

// The eight domain tools of Apache Doris MCP 1.0 (hierarchical mode).
export const DORIS_TOOLS = new Set([
  "doris_catalog",
  "doris_query",
  "doris_cluster",
  "doris_pipeline",
  "doris_search",
  "doris_governance",
  "doris_lakehouse",
  "doris_semantic",
]);

// Convenience checks that give a clear refusal. The boundary is the database
// role: the read-only Cassandra role holds SELECT and nothing else.
const SINGLE_STATEMENT = /^[^;]*;?\s*$/;
const CQL_READ = /^\s*select\b/i;
const CQL_WRITE = /^\s*(insert|update|delete|begin\s+(unlogged\s+)?batch)\b/i;

export function checkCql(access: Access, cql: string): void {
  if (!SINGLE_STATEMENT.test(cql)) throw new RelayError(400, "one CQL statement per call");
  if (access === "read" && !CQL_READ.test(cql)) {
    throw new RelayError(400, "cassandra_select runs SELECT statements only");
  }
  if (access === "write" && !CQL_WRITE.test(cql)) {
    throw new RelayError(
      400,
      "cassandra_execute runs INSERT, UPDATE, DELETE or BATCH; schema changes go through cqlsh-admin",
    );
  }
}

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new RelayError(400, `${name} must be a non-empty string`);
  return v;
};
const optStr = (v: unknown, name: string): string | undefined =>
  v === undefined ? undefined : str(v, name);
const limit = (v: unknown): number => {
  const n = v === undefined ? 100 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new RelayError(400, "limit must be 1–1000");
  return n;
};
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : []);
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
// CQL identifiers are interpolated into system_schema queries as bind values,
// never as text; this only keeps error messages sane.
const ident = (v: unknown, name: string): string => {
  const s = str(v, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,47}$/.test(s))
    throw new RelayError(400, `${name} is not a valid identifier`);
  return s;
};

export const OPS: Record<string, OpSpec> = {
  "doris.callTool": {
    store: "doris",
    access: "read",
    run: (b, a) => {
      const tool = str(a.tool, "tool");
      if (!DORIS_TOOLS.has(tool)) throw new RelayError(400, `unknown Doris tool ${tool}`);
      return b.doris.callTool(tool, record(a.input));
    },
  },

  "cassandra.listKeyspaces": {
    store: "cassandra",
    access: "read",
    run: (b) =>
      b.cassandra.execute(
        "read",
        "SELECT keyspace_name, replication FROM system_schema.keyspaces",
        [],
        1000,
      ),
  },
  "cassandra.listTables": {
    store: "cassandra",
    access: "read",
    run: (b, a) =>
      b.cassandra.execute(
        "read",
        "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?",
        [ident(a.keyspace, "keyspace")],
        1000,
      ),
  },
  "cassandra.describeTable": {
    store: "cassandra",
    access: "read",
    run: (b, a) =>
      b.cassandra.execute(
        "read",
        "SELECT column_name, kind, position, type, clustering_order FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?",
        [ident(a.keyspace, "keyspace"), ident(a.table, "table")],
        1000,
      ),
  },
  "cassandra.select": {
    store: "cassandra",
    access: "read",
    run: (b, a) => {
      const cql = str(a.cql, "cql");
      checkCql("read", cql);
      return b.cassandra.execute("read", cql, list(a.params), limit(a.limit));
    },
  },
  "cassandra.execute": {
    store: "cassandra",
    access: "write",
    run: (b, a) => {
      const cql = str(a.cql, "cql");
      checkCql("write", cql);
      return b.cassandra.execute("write", cql, list(a.params), 1);
    },
  },

  "graph.summary": {
    store: "graph",
    access: "read",
    run: (b) => b.graph.summary(),
  },
  "graph.findVertices": {
    store: "graph",
    access: "read",
    run: (b, a) => b.graph.findVertices(optStr(a.label, "label"), record(a.has), limit(a.limit)),
  },
  "graph.neighbours": {
    store: "graph",
    access: "read",
    run: (b, a) => {
      const id = a.vertexId;
      if (typeof id !== "string" && typeof id !== "number") {
        throw new RelayError(400, "vertexId must be a string or number");
      }
      const direction = a.direction ?? "both";
      if (direction !== "out" && direction !== "in" && direction !== "both") {
        throw new RelayError(400, "direction must be out, in or both");
      }
      return b.graph.neighbours(id, direction, optStr(a.edgeLabel, "edgeLabel"), limit(a.limit));
    },
  },
  "graph.gremlin": {
    store: "graph",
    access: "write",
    run: (b, a) => b.graph.evaluate(str(a.script, "script"), record(a.bindings)),
  },
};

export interface CallBody {
  store: Store;
  op: string;
  args: unknown;
  caller: { id: string; email?: string; scopes: string[] };
}

export function parseBody(raw: string): CallBody {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new RelayError(400, "body is not JSON");
  }
  const b = record(body);
  const caller = record(b.caller);
  if (typeof b.store !== "string" || typeof b.op !== "string" || typeof caller.id !== "string") {
    throw new RelayError(400, "body needs store, op and caller.id");
  }
  return {
    store: b.store as Store,
    op: b.op,
    args: b.args,
    caller: {
      id: caller.id,
      email: typeof caller.email === "string" ? caller.email : undefined,
      scopes: list(caller.scopes).filter((s): s is string => typeof s === "string"),
    },
  };
}

// Defence in depth behind the Worker's own gate: the signed body says which
// scopes the caller holds, and the relay applies the same rule, plus its own
// switch — writes are off for every store unless RELAY_ALLOW_WRITES names it.
export function authorise(body: CallBody, allowWrites: ReadonlySet<string>): OpSpec {
  const spec = OPS[`${body.store}.${body.op}`];
  if (!spec) throw new RelayError(404, `unknown operation ${body.store}.${body.op}`);
  const needed =
    spec.access === "read"
      ? [`${spec.store}:access`]
      : [`${spec.store}:access`, `${spec.store}:write`];
  if (!needed.every((scope) => body.caller.scopes.includes(scope))) {
    throw new RelayError(403, `caller lacks ${needed.join(" + ")}`);
  }
  if (spec.access === "write" && !allowWrites.has(spec.store)) {
    throw new RelayError(
      403,
      `writes to ${spec.store} are disabled on the relay (RELAY_ALLOW_WRITES)`,
    );
  }
  return spec;
}

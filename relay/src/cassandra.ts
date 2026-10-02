import cassandra from "cassandra-driver";
import type { Access, CassandraBackend, Rows } from "./ops.ts";
import { RelayError } from "./ops.ts";

export interface CassandraConfig {
  contactPoints: string[];
  localDataCenter: string;
  readUser: string;
  readPassword?: string;
  writeUser?: string;
  writePassword?: string;
}

// Driver value types (Long, Uuid, InetAddress, BigDecimal, …) serialise as
// opaque objects; their toString() is the readable form.
function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  if (value instanceof Set) return [...value].map(plain);
  if (typeof value === "object") {
    const ctor = (value as object).constructor?.name;
    if (ctor && ctor !== "Object" && ctor !== "Row") return String(value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

// One client per role, created on first use. Reads always use the read-only
// role; the read-write client exists only if its password is configured.
export function cassandraBackend(config: CassandraConfig): CassandraBackend {
  const clients = new Map<Access, cassandra.Client>();

  function client(access: Access): cassandra.Client {
    const existing = clients.get(access);
    if (existing) return existing;
    const user = access === "read" ? config.readUser : config.writeUser;
    const password = access === "read" ? config.readPassword : config.writePassword;
    if (!user || !password) {
      throw new RelayError(503, `no Cassandra ${access} credential is configured on the relay`);
    }
    const created = new cassandra.Client({
      contactPoints: config.contactPoints,
      localDataCenter: config.localDataCenter,
      authProvider: new cassandra.auth.PlainTextAuthProvider(user, password),
      applicationName: "nyuchi-data-relay",
      socketOptions: { connectTimeout: 10_000, readTimeout: 20_000 },
    });
    clients.set(access, created);
    return created;
  }

  return {
    async execute(access, cql, params, limit): Promise<Rows> {
      const result = await client(access).execute(cql, params, {
        prepare: true,
        fetchSize: limit,
      });
      const rows = (result.rows ?? []).slice(0, limit).map((row) => plain({ ...row }));
      return { rows, truncated: Boolean(result.pageState) };
    },
  };
}

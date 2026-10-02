import { tmpdir } from "node:os";
import { cassandraBackend } from "./cassandra.ts";
import { dorisBackend, dorisChildEnv, StdioMcpClient } from "./doris.ts";
import { graphBackend } from "./graph.ts";
import { NonceCache, startServer } from "./server.ts";

const env = process.env;

const secret = env.RELAY_SIGNING_SECRET ?? "";
if (secret.length < 32) {
  console.error(
    "RELAY_SIGNING_SECRET is missing or shorter than 32 characters; refusing to start.",
  );
  process.exit(1);
}

// Writes are off for every store unless named here, e.g. "cassandra,graph".
const allowWrites = new Set(
  (env.RELAY_ALLOW_WRITES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const doris = new StdioMcpClient(
  env.DORIS_MCP_COMMAND ?? "doris-mcp-server",
  ["--transport", "stdio"],
  dorisChildEnv(env),
  60_000,
  env.DORIS_MCP_WORKDIR ?? tmpdir(),
);

const server = startServer(Number(env.PORT ?? 8080), {
  secret,
  allowWrites,
  nonces: new NonceCache(),
  backends: {
    doris: dorisBackend(doris),
    cassandra: cassandraBackend({
      contactPoints: (env.CASSANDRA_CONTACT_POINTS ?? "nyuchi-cassandra.internal").split(","),
      localDataCenter: env.CASSANDRA_LOCAL_DC ?? "jnb",
      readUser: env.CASSANDRA_RO_USER ?? "nyuchi_mcp_ro",
      readPassword: env.CASSANDRA_MCP_RO_PASSWORD,
      writeUser: env.CASSANDRA_RW_USER,
      writePassword: env.CASSANDRA_MCP_RW_PASSWORD,
    }),
    graph: graphBackend({
      url: env.GREMLIN_URL ?? "ws://nyuchi-janusgraph.internal:8182/gremlin",
      user: env.GREMLIN_USER ?? "nyuchi_api",
      password: env.GREMLIN_PASSWORD,
    }),
  },
});

console.log(
  JSON.stringify({
    event: "relay_started",
    port: env.PORT ?? 8080,
    writes: [...allowWrites],
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    doris.close();
    server.close(() => process.exit(0));
  });
}

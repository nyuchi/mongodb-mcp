import gremlin from "gremlin";
import type { GraphBackend } from "./ops.ts";

export interface GraphConfig {
  url: string;
  user: string;
  password?: string;
}

const { DriverRemoteConnection, Client } = gremlin.driver;
const { PlainTextSaslAuthenticator } = gremlin.driver.auth;
const { AnonymousTraversalSource, ReadOnlyStrategy, t: T } = gremlin.process;

// Gremlin results arrive as Maps keyed by strings or by T enum values (id,
// label); flatten them to plain JSON.
function plain(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value].map(([k, v]) => [
        typeof k === "object" && k !== null ? String(k.elementName ?? k) : String(k),
        plain(v),
      ]),
    );
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "bigint") return value.toString();
  return value;
}

// Read tools build their traversals here, from structured arguments, with
// ReadOnlyStrategy attached: the server rejects any mutating step in them.
// Callers never send Gremlin text to these. Raw scripts (evaluate) are a
// write-scoped tool because a Groovy script can do anything the user can.
export function graphBackend(config: GraphConfig): GraphBackend {
  let connection: InstanceType<typeof DriverRemoteConnection> | undefined;
  let scriptClient: InstanceType<typeof Client> | undefined;

  const authenticator = () => {
    if (!config.password) throw new Error("GREMLIN_PASSWORD is not configured on the relay");
    return new PlainTextSaslAuthenticator(config.user, config.password);
  };

  const g = () => {
    connection ??= new DriverRemoteConnection(config.url, {
      authenticator: authenticator(),
      traversalSource: "g",
    });
    return AnonymousTraversalSource.traversal()
      .withRemote(connection)
      .withStrategies(new ReadOnlyStrategy());
  };

  return {
    async summary() {
      const vertices = await g().V().groupCount().by(T.label).next();
      const edges = await g().E().groupCount().by(T.label).next();
      return { vertices: plain(vertices.value), edges: plain(edges.value) };
    },

    async findVertices(label, has, limit) {
      let traversal = label ? g().V().hasLabel(label) : g().V();
      for (const [key, value] of Object.entries(has)) traversal = traversal.has(key, value);
      return plain(await traversal.limit(limit).elementMap().toList());
    },

    async neighbours(vertexId, direction, edgeLabel, limit) {
      const labels = edgeLabel ? [edgeLabel] : [];
      const start = g().V(vertexId);
      const step =
        direction === "out"
          ? start.out(...labels)
          : direction === "in"
            ? start.in_(...labels)
            : start.both(...labels);
      return plain(await step.limit(limit).elementMap().toList());
    },

    async evaluate(script, bindings) {
      scriptClient ??= new Client(config.url, {
        authenticator: authenticator(),
        traversalSource: "g",
      });
      const result = await scriptClient.submit(script, bindings);
      return plain(result.toArray());
    },
  };
}

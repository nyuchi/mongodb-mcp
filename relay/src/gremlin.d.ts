// gremlin (gremlin-javascript 3.7) ships no type declarations. This covers
// only the surface relay/src/graph.ts uses, loosely; the driver is exercised
// against a real JanusGraph by the owner's smoke test, not by tsc.
declare module "gremlin" {
  type Any = any;
  const gremlin: {
    driver: {
      DriverRemoteConnection: new (url: string, options: Record<string, unknown>) => Any;
      Client: new (url: string, options: Record<string, unknown>) => Any;
      auth: {
        PlainTextSaslAuthenticator: new (user: string, password: string) => Any;
      };
    };
    process: {
      AnonymousTraversalSource: { traversal(): Any };
      ReadOnlyStrategy: new () => Any;
      t: { id: Any; label: Any };
    };
  };
  export default gremlin;
}

import type { McpServer } from "@modelcontextprotocol/server";
import type { AuditSink } from "./audit";
import type { Caller } from "./props";
import { type Access, type Store, isPermitted, scopesFor } from "./scopes";

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

type Annotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

type ToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Annotations;
};

type Handler = (args: never, extra: never) => Promise<ToolResult>;

export interface ToolSpec {
  store: Store;
  name: string;
  access: Access;
  config: ToolConfig;
  handler: Handler;
}

// Tools are namespaced by store so that five stores can each have a `query`
// without colliding. A name that already carries its prefix (doris_catalog,
// the names Apache's Doris MCP uses) is left alone.
export function exposedName(store: Store, name: string): string {
  return name.startsWith(`${store}_`) ? name : `${store}_${name}`;
}

// The write scope is derived from the tool's own annotations rather than kept
// in a second list: a tool that does not declare itself read-only is treated
// as a write. Forgetting the hint therefore over-protects, never under-protects.
export function accessOf(annotations: Annotations | undefined): Access {
  return annotations?.readOnlyHint === true ? "read" : "write";
}

function denied(spec: ToolSpec): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Refused: ${spec.name} needs the WorkOS permission(s) ${scopesFor(spec.store, spec.access).join(" + ")}. Ask the owner to grant them to your role, then reconnect.`,
      },
    ],
    isError: true,
  };
}

function crashed(err: unknown): ToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

export class ToolRegistry {
  private readonly specs = new Map<string, ToolSpec>();

  add(spec: ToolSpec): void {
    if (this.specs.has(spec.name)) {
      throw new Error(`Tool '${spec.name}' is registered twice.`);
    }
    this.specs.set(spec.name, spec);
  }

  // A stand-in for McpServer that the per-store register functions write into.
  // `only` lets one store register the same catalogue twice against different
  // credentials — reads with the read-only one, writes with the read-write one —
  // and keep just the half each credential is for.
  collector(store: Store, only?: Access): McpServer {
    const sink = {
      registerTool: (name: string, config: ToolConfig, handler: Handler) => {
        const access = accessOf(config.annotations);
        if (only && access !== only) return {};
        this.add({
          store,
          name: exposedName(store, name),
          access,
          config,
          handler,
        });
        return {};
      },
    };
    return sink as unknown as McpServer;
  }

  list(): ToolSpec[] {
    return [...this.specs.values()];
  }

  permitted(scopes: readonly string[]): ToolSpec[] {
    return this.list().filter((spec) => isPermitted(scopes, spec.store, spec.access));
  }

  // Registers on the real server only the tools this caller may use, so
  // tools/list itself reflects their permissions. Each handler re-checks at
  // call time and writes one audit line whatever the outcome.
  mount(
    server: McpServer,
    caller: Caller,
    audit: AuditSink,
    clock: () => number = Date.now,
  ): string[] {
    const mounted: string[] = [];
    for (const spec of this.permitted(caller.scopes)) {
      const guarded = async (args: never, extra: never): Promise<ToolResult> => {
        const started = clock();
        const record = (outcome: "ok" | "error" | "denied") =>
          audit({
            event: "tool_call",
            at: new Date(started).toISOString(),
            user: caller.id,
            email: caller.email,
            organizationId: caller.organizationId,
            tool: spec.name,
            store: spec.store,
            access: spec.access,
            outcome,
            durationMs: Math.max(0, clock() - started),
          });

        if (!isPermitted(caller.scopes, spec.store, spec.access)) {
          record("denied");
          return denied(spec);
        }
        try {
          const result = await spec.handler(args, extra);
          record(result.isError ? "error" : "ok");
          return result;
        } catch (err) {
          record("error");
          return crashed(err);
        }
      };
      server.registerTool(spec.name, spec.config as never, guarded as never);
      mounted.push(spec.name);
    }
    return mounted;
  }
}

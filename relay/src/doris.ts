import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { DorisBackend } from "./ops.ts";

// Apache Doris MCP runs as a child process speaking MCP over stdio. stdio
// rather than its Streamable HTTP transport because then it opens no port at
// all: nothing else on the machine or the network can talk to it, and it needs
// no bearer token of its own. The relay is its only client.
//
// Doris MCP 1.0 prefers MCP revision 2026-07-28, which has no initialize
// handshake: every request is self-contained and carries the protocol version
// in params._meta. That is all this client does — newline-delimited JSON-RPC.
export const PROTOCOL_VERSION = "2026-07-28";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class StdioMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly command: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly cwd?: string;

  // cwd matters: Doris MCP writes its logs under ./logs, so it needs a
  // directory the relay's (non-root) user can write.
  constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs = 60_000,
    cwd?: string,
  ) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
  }

  // Started lazily and restarted after an exit, so a crash costs one failed
  // call rather than the relay.
  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    // Doris MCP logs to stderr; pass it through with a prefix, never to stdout.
    createInterface({ input: child.stderr }).on("line", (line) =>
      console.error(`[doris-mcp] ${line}`),
    );
    child.on("exit", (code) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`Doris MCP exited (code ${code}) before answering`));
        this.pending.delete(id);
      }
    });
    this.child = child;
    return child;
  }

  private onLine(line: string): void {
    let message: {
      id?: unknown;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    clearTimeout(p.timer);
    if (message.error) p.reject(new Error(`Doris MCP: ${message.error.message ?? "error"}`));
    else p.resolve(message.result);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.ensure();
    const id = this.nextId++;
    const frame = {
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "nyuchi-data-relay",
            version: "0.1.0",
          },
        },
      },
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Doris MCP did not answer ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  close(): void {
    this.child?.kill("SIGTERM");
  }
}

export function dorisBackend(client: StdioMcpClient): DorisBackend {
  return {
    callTool: (tool, input) => client.request("tools/call", { name: tool, arguments: input }),
  };
}

// The environment Doris MCP reads (its docs/reference/configuration.md). Only
// these pass to the child; the relay's own secrets (the signing key, the
// Cassandra and Gremlin passwords) never reach it.
export function dorisChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH,
    HOME: env.HOME,
    TRANSPORT: "stdio",
    MCP_TOOL_EXPOSURE_MODE: "hierarchical",
    DORIS_HOST: env.DORIS_HOST ?? "mukoko-doris.internal",
    DORIS_PORT: env.DORIS_PORT ?? "9030",
    DORIS_USER: env.DORIS_USER ?? "nyuchi_mcp_ro",
    DORIS_PASSWORD: env.DORIS_MCP_RO_PASSWORD ?? "",
    DORIS_DATABASE: env.DORIS_DATABASE ?? "information_schema",
    DORIS_FE_HTTP_PORT: env.DORIS_FE_HTTP_PORT ?? "8030",
  };
}

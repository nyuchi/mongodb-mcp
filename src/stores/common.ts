import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { stringifyEJson } from "../ejson";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: stringifyEJson(value) }] };
}

export function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

// The same three shapes src/tools.ts uses for MongoDB. A tool's readOnlyHint
// is also what decides whether it needs `<store>:write` (src/registry.ts).
export const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const MUTATE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export type ToolHints = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

// The registration helper from src/tools.ts, shared by the other stores: it
// wraps SDK v2's registerTool and converts throws into fail() results.
export function toolDefiner(server: McpServer) {
  return <Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    { title, ...behaviour }: ToolHints,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: z.object(shape),
        annotations: behaviour,
      },
      (async (args: z.infer<z.ZodObject<Shape>>) => {
        try {
          return ok(await handler(args));
        } catch (e) {
          return fail(e);
        }
      }) as never,
    );
  };
}

export const confirmArg = {
  confirm: z
    .literal(true)
    .describe("Must be true. This tool changes data and cannot be undone by the server."),
};

export const limitArg = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe("Maximum rows or elements to return (1–1000)."),
};

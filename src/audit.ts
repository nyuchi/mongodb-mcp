import type { Access, Store } from "./scopes";

// One line per tool call: who called which tool on which store, how it ended
// and how long it took. Arguments and results are deliberately absent — they
// can carry personal data and query text that has no business in a log.
export interface AuditEvent {
  event: "tool_call";
  at: string;
  user: string;
  email?: string;
  organizationId?: string;
  tool: string;
  store: Store;
  access: Access;
  outcome: "ok" | "error" | "denied";
  durationMs: number;
}

export type AuditSink = (event: AuditEvent) => void;

// Workers Logs (observability.logs in wrangler.jsonc) persists console output,
// and a JSON line is queryable there by field.
export const consoleAuditSink: AuditSink = (event) => {
  console.log(JSON.stringify(event));
};

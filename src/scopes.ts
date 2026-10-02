// Every store the data MCP reaches, and the WorkOS permissions that open it.
//
// The WorkOS Connect app surfaces permissions as OAuth scopes, so these strings
// are both the permission slugs defined in the WorkOS dashboard and the scopes
// the worker requests at sign-in. Each store has two: `<store>:access` admits
// its read-only tools, and `<store>:write` is needed — on top of access — for
// any tool that can change data. Read-only is the default because write is a
// second, separately granted permission.
export const STORES = ["mongodb", "supabase", "doris", "cassandra", "graph"] as const;
export type Store = (typeof STORES)[number];

export type Access = "read" | "write";

export function accessScope(store: Store): string {
  return `${store}:access`;
}

export function writeScope(store: Store): string {
  return `${store}:write`;
}

export function scopesFor(store: Store, access: Access): string[] {
  return access === "read" ? [accessScope(store)] : [accessScope(store), writeScope(store)];
}

// The scopes requested at sign-in. WorkOS grants only those the user's org role
// holds, so asking for all of them is how one sign-in picks up whatever subset
// the operator has been given.
export const ALL_STORE_SCOPES: readonly string[] = STORES.flatMap((store) => [
  accessScope(store),
  writeScope(store),
]);

// Holding any one of these gets a session past the front door; which tools it
// then sees is decided per store.
export const ENTRY_SCOPES: readonly string[] = STORES.map(accessScope);

// Exact matching only: `mongodb:access:admin` or `xmongodb:access` grant nothing.
export function isPermitted(granted: readonly string[], store: Store, access: Access): boolean {
  return scopesFor(store, access).every((scope) => granted.includes(scope));
}

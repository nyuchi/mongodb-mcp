export interface Props {
  user: { id: string; email?: string; name?: string };
  accessToken: string;
  idToken: string;
  refreshToken: string;
  permissions: string[];
  organizationId?: string;

  // Required so Props satisfies McpAgent's `Record<string, unknown>` constraint.
  [key: string]: unknown;
}

// The part of a session the tool layer needs: who is calling and what they
// were granted. Built from the OAuth props on every request.
export interface Caller {
  id: string;
  email?: string;
  organizationId?: string;
  scopes: readonly string[];
}

// Anything malformed becomes an anonymous caller with no scopes, which sees no
// tools. Missing props mean the request did not come through the OAuth
// provider, and the answer to that is nothing, not a default.
export function callerFromProps(props: Record<string, unknown> | undefined): Caller {
  const user = props?.user as Props["user"] | undefined;
  const permissions = props?.permissions;
  return {
    id: typeof user?.id === "string" && user.id ? user.id : "anonymous",
    email: typeof user?.email === "string" ? user.email : undefined,
    organizationId:
      typeof props?.organizationId === "string" ? (props.organizationId as string) : undefined,
    scopes: Array.isArray(permissions)
      ? permissions.filter((p): p is string => typeof p === "string")
      : [],
  };
}

import type { User } from "@workos-inc/node";

export interface Props {
  user: User;
  accessToken: string;
  refreshToken: string;
  permissions: string[];
  organizationId?: string;

  // Required so Props satisfies McpAgent's `Record<string, unknown>` constraint.
  [key: string]: unknown;
}

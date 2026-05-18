import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type AccessToken, type AuthenticationResponse, WorkOS } from "@workos-inc/node";
import { Hono } from "hono";
import * as jose from "jose";
import type { Props } from "./props";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{
  Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
  Variables: { workOS: WorkOS };
}>();

function requireWorkOS(c: {
  env: Env;
  set: (k: "workOS", v: WorkOS) => void;
  get: (k: "workOS") => WorkOS | undefined;
}): WorkOS {
  let workOS = c.get("workOS");
  if (workOS) return workOS;
  if (!c.env.WORKOS_CLIENT_SECRET) {
    throw new Error(
      "WORKOS_CLIENT_SECRET is not configured. Add it as a Worker secret before using auth routes.",
    );
  }
  workOS = new WorkOS(c.env.WORKOS_CLIENT_SECRET);
  c.set("workOS", workOS);
  return workOS;
}

app.get("/", (c) => {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>MongoDB MCP</title></head>
     <body style="font-family: -apple-system, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem;">
       <h1>MongoDB MCP</h1>
       <p>Authenticated remote MCP server for managing MongoDB. Point your MCP client at <code>/mcp</code> and complete the WorkOS sign-in.</p>
     </body></html>`,
  );
});

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
    return redirectToAuthKit(c, stateToken, { "Set-Cookie": sessionBindingCookie });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description:
        "Authenticated MCP for managing MongoDB. WorkOS verifies your identity before the MCP client gets access.",
      name: "MongoDB MCP",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
      return c.text("Invalid request", 400);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToAuthKit(c, stateToken, Object.fromEntries(headers));
  } catch (error: unknown) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) return error.toResponse();
    const message = error instanceof Error ? error.message : String(error);
    return c.text(`Internal server error: ${message}`, 500);
  }
});

function redirectToAuthKit(
  c: {
    env: Env;
    req: { url: string };
    set: (k: "workOS", v: WorkOS) => void;
    get: (k: "workOS") => WorkOS | undefined;
  },
  stateToken: string,
  headers: Record<string, string> = {},
) {
  const workOS = requireWorkOS(c);
  return new Response(null, {
    headers: {
      ...headers,
      location: workOS.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: c.env.WORKOS_CLIENT_ID,
        redirectUri: new URL("/callback", c.req.url).href,
        state: stateToken,
      }),
    },
    status: 302,
  });
}

app.get("/callback", async (c) => {
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: unknown) {
    if (error instanceof OAuthError) return error.toResponse();
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing code", 400);
  }

  const workOS = requireWorkOS(c);
  let response: AuthenticationResponse;
  try {
    response = await workOS.userManagement.authenticateWithCode({
      clientId: c.env.WORKOS_CLIENT_ID,
      code,
    });
  } catch (error) {
    console.error("Authentication error:", error);
    return c.text("Invalid authorization code", 400);
  }

  const { accessToken, organizationId, refreshToken, user } = response;
  const { permissions = [] } = jose.decodeJwt<AccessToken>(accessToken);

  const allowedOrgs = (c.env.WORKOS_ALLOWED_ORG_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowedOrgs.length > 0 && (!organizationId || !allowedOrgs.includes(organizationId))) {
    return c.text("Your WorkOS organization is not authorized to use this MCP server.", 403);
  }

  const requiredPermission = (c.env.WORKOS_REQUIRED_PERMISSION || "").trim();
  if (requiredPermission && !permissions.includes(requiredPermission)) {
    return c.text(
      `Missing required permission "${requiredPermission}". Ask your WorkOS admin to grant it.`,
      403,
    );
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.id,
    metadata: {},
    scope: permissions,
    props: {
      accessToken,
      organizationId,
      permissions,
      refreshToken,
      user,
    } satisfies Props,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, { status: 302, headers });
});

export const AuthkitHandler = app;

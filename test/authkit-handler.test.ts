import { describe, expect, it } from "vitest";
import { AuthkitHandler } from "../src/authkit-handler";

type OAuthHelpersStub = {
  parseAuthRequest: (req: Request) => Promise<unknown>;
  lookupClient: (clientId: string) => Promise<unknown>;
};

function makeEnv(overrides: Partial<Env> = {}): Env & { OAUTH_PROVIDER: OAuthHelpersStub } {
  return {
    MCP_OBJECT: undefined as unknown as DurableObjectNamespace,
    OAUTH_KV: undefined as unknown as KVNamespace,
    WORKOS_CLIENT_ID: "client_test",
    WORKOS_CLIENT_SECRET: "sk_test_workos_client_secret",
    COOKIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    MONGODB_URI: "mongodb://invalid.test:27017",
    WORKOS_ALLOWED_ORG_IDS: "",
    WORKOS_REQUIRED_PERMISSION: "",
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => ({ clientId: "" }),
      lookupClient: async () => null,
    },
    ...overrides,
  };
}

describe("AuthkitHandler", () => {
  it("renders the landing page on GET /", async () => {
    const res = await AuthkitHandler.fetch(new Request("https://example.com/"), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const body = await res.text();
    expect(body).toContain("MongoDB MCP");
  });

  it("rejects GET /authorize when client_id is missing", async () => {
    const res = await AuthkitHandler.fetch(new Request("https://example.com/authorize"), makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects POST /authorize with no CSRF token", async () => {
    const form = new URLSearchParams({ state: btoa(JSON.stringify({})) });
    const res = await AuthkitHandler.fetch(
      new Request("https://example.com/authorize", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects GET /callback without state", async () => {
    const res = await AuthkitHandler.fetch(new Request("https://example.com/callback"), makeEnv());
    expect(res.status).toBe(400);
  });

  it("shows the approval dialog when /authorize sees a valid client_id", async () => {
    const env = makeEnv({
      OAUTH_PROVIDER: {
        parseAuthRequest: async () => ({
          clientId: "client-abc",
          redirectUri: "https://client.example.com/callback",
          state: "client-state",
          scope: [],
          responseType: "code",
          codeChallenge: "x".repeat(43),
          codeChallengeMethod: "S256",
        }),
        lookupClient: async () => ({
          clientId: "client-abc",
          clientName: "Demo MCP Client",
          redirectUris: ["https://client.example.com/callback"],
        }),
      },
    });

    const res = await AuthkitHandler.fetch(
      new Request("https://example.com/authorize?client_id=client-abc"),
      env,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Demo MCP Client");
    expect(html).toContain("csrf_token");
    expect(res.headers.get("set-cookie") ?? "").toContain("__Host-CSRF_TOKEN");
  });
});

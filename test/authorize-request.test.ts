import type {
  AuthRequest,
  ClientInfo,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";
import { AuthkitHandler } from "../src/authkit-handler";
import { parseAuthRequestOrReject } from "../src/authorize-request";

const AUTHORIZE =
  "https://mongodb.nyuchi.dev/authorize?response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb";

const knownClient = {
  clientId: "known",
  redirectUris: ["https://example.com/cb"],
} as ClientInfo;
const parsedRequest = {
  clientId: "known",
  redirectUri: "https://example.com/cb",
} as AuthRequest;

function provider(overrides: Partial<OAuthHelpers> = {}) {
  return {
    lookupClient: async (id: string) => (id === "known" ? knownClient : null),
    parseAuthRequest: async () => parsedRequest,
    ...overrides,
  } as Pick<OAuthHelpers, "parseAuthRequest" | "lookupClient">;
}

async function expectError(result: AuthRequest | Response, code: string) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: string }).error).toBe(code);
}

describe("parseAuthRequestOrReject", () => {
  it("answers a missing client_id with 400 invalid_request", async () => {
    await expectError(
      await parseAuthRequestOrReject(new Request(AUTHORIZE), provider()),
      "invalid_request",
    );
  });

  it("answers an unregistered client_id with 400 invalid_client", async () => {
    await expectError(
      await parseAuthRequestOrReject(
        new Request(`${AUTHORIZE}&client_id=bogus`),
        provider(),
      ),
      "invalid_client",
    );
  });

  it("treats a client lookup that throws as an unknown client", async () => {
    const throwing = provider({
      lookupClient: async () => {
        throw new Error("Failed to fetch client metadata: HTTP 404");
      },
    });
    await expectError(
      await parseAuthRequestOrReject(
        new Request(`${AUTHORIZE}&client_id=https://x.test/c`),
        throwing,
      ),
      "invalid_client",
    );
  });

  it("answers a request the provider rejects with 400 invalid_request", async () => {
    const rejecting = provider({
      parseAuthRequest: async () => {
        throw new Error("Invalid redirect URI");
      },
    });
    await expectError(
      await parseAuthRequestOrReject(
        new Request(`${AUTHORIZE}&client_id=known`),
        rejecting,
      ),
      "invalid_request",
    );
  });

  it("passes a valid request through", async () => {
    const result = await parseAuthRequestOrReject(
      new Request(`${AUTHORIZE}&client_id=known`),
      provider(),
    );
    expect(result).toBe(parsedRequest);
  });
});

describe("GET /authorize", () => {
  it("returns 400 invalid_client, not 500, for an unregistered client", async () => {
    const response = await AuthkitHandler.fetch(
      new Request(`${AUTHORIZE}&client_id=bogus`),
      {
        WORKOS_AUTHKIT_DOMAIN: "https://identity.example.test",
        OAUTH_PROVIDER: provider({
          parseAuthRequest: async () => {
            throw new Error("Invalid client");
          },
        }),
      } as unknown as Env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});

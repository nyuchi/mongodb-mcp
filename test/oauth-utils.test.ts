import { describe, expect, it } from "vitest";
import {
  OAuthError,
  addApprovedClient,
  bindStateToSession,
  generateCSRFProtection,
  isClientApproved,
  sanitizeText,
  sanitizeUrl,
  validateCSRFToken,
} from "../src/workers-oauth-utils";

describe("sanitizeText", () => {
  it("escapes HTML special characters", () => {
    expect(sanitizeText(`<script>alert('xss')</script>`)).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;",
    );
  });

  it("escapes ampersands and quotes", () => {
    expect(sanitizeText(`a & "b"`)).toBe("a &amp; &quot;b&quot;");
  });
});

describe("sanitizeUrl", () => {
  it("accepts https/http URLs", () => {
    expect(sanitizeUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects non-http schemes", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("");
    expect(sanitizeUrl("data:text/html,foo")).toBe("");
    expect(sanitizeUrl("file:///etc/passwd")).toBe("");
  });

  it("rejects URLs containing control characters", () => {
    expect(sanitizeUrl("https://example.com/\x00")).toBe("");
    expect(sanitizeUrl("https://example.com/\x1f")).toBe("");
  });

  it("returns empty string for malformed URLs", () => {
    expect(sanitizeUrl("not a url")).toBe("");
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("CSRF protection", () => {
  it("generates a token and matching Set-Cookie header", () => {
    const { token, setCookie } = generateCSRFProtection();
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(setCookie).toContain("__Host-CSRF_TOKEN=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
  });

  it("validates a matching token + cookie", () => {
    const { token } = generateCSRFProtection();
    const formData = new FormData();
    formData.set("csrf_token", token);
    const request = new Request("https://example.com/authorize", {
      headers: { cookie: `__Host-CSRF_TOKEN=${token}` },
    });
    const { clearCookie } = validateCSRFToken(formData, request);
    expect(clearCookie).toContain("Max-Age=0");
  });

  it("rejects when the form token is missing", () => {
    const formData = new FormData();
    const request = new Request("https://example.com/authorize", {
      headers: { cookie: "__Host-CSRF_TOKEN=anything" },
    });
    expect(() => validateCSRFToken(formData, request)).toThrowError(OAuthError);
  });

  it("rejects when form and cookie tokens differ", () => {
    const formData = new FormData();
    formData.set("csrf_token", "token-A");
    const request = new Request("https://example.com/authorize", {
      headers: { cookie: "__Host-CSRF_TOKEN=token-B" },
    });
    expect(() => validateCSRFToken(formData, request)).toThrowError(/CSRF token mismatch/);
  });
});

describe("state binding cookie", () => {
  it("hashes the state token into the cookie value", async () => {
    const stateToken = "abc-state-token";
    const { setCookie } = await bindStateToSession(stateToken);
    expect(setCookie).toMatch(/^__Host-CONSENTED_STATE=[0-9a-f]{64};/);
  });
});

describe("approved-clients cookie", () => {
  const secret = "test-cookie-secret";

  it("signs and verifies the approved-clients cookie", async () => {
    const setCookie = await addApprovedClient(
      new Request("https://example.com/authorize"),
      "client-id-1",
      secret,
    );
    const cookieHeader = setCookie.split(";")[0];
    const verifyReq = new Request("https://example.com/authorize", {
      headers: { cookie: cookieHeader },
    });
    expect(await isClientApproved(verifyReq, "client-id-1", secret)).toBe(true);
    expect(await isClientApproved(verifyReq, "other-client", secret)).toBe(false);
  });

  it("rejects cookies signed with a different secret", async () => {
    const setCookie = await addApprovedClient(
      new Request("https://example.com/authorize"),
      "client-id-1",
      secret,
    );
    const cookieHeader = setCookie.split(";")[0];
    const verifyReq = new Request("https://example.com/authorize", {
      headers: { cookie: cookieHeader },
    });
    expect(await isClientApproved(verifyReq, "client-id-1", "different-secret")).toBe(false);
  });

  it("returns false when no cookie is present", async () => {
    const req = new Request("https://example.com/authorize");
    expect(await isClientApproved(req, "client-id-1", secret)).toBe(false);
  });
});

describe("OAuthError", () => {
  it("serialises to the OAuth error response shape", async () => {
    const err = new OAuthError("invalid_request", "missing thing", 400);
    const res = err.toResponse();
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Record<string, string>;
    expect(body).toEqual({ error: "invalid_request", error_description: "missing thing" });
  });
});

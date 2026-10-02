import { describe, expect, it } from "vitest";
import { AuthkitHandler, authkitDomain, normaliseAuthkitDomain } from "../src/authkit-handler";

describe("authkitDomain — configuration only, no compiled-in default", () => {
  it("is null when WORKOS_AUTHKIT_DOMAIN is unset or blank", () => {
    expect(authkitDomain({} as Env)).toBeNull();
    expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: "  " } as Env)).toBeNull();
  });

  it("normalises a bare host or an https origin, trimming a trailing slash", () => {
    expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: " identity.example.test/ " } as Env)).toBe(
      "https://identity.example.test",
    );
    expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: "https://identity.example.test/" } as Env)).toBe(
      "https://identity.example.test",
    );
  });

  it("returns the configured https origin unchanged", () => {
    expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: "https://identity.example.test" } as Env)).toBe(
      "https://identity.example.test",
    );
  });

  it("accepts a mixed-case scheme and host, and drops any path, query or fragment", () => {
    expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: "HTTPS://Identity.Example.Test" } as Env)).toBe(
      "https://identity.example.test",
    );
    expect(
      authkitDomain({ WORKOS_AUTHKIT_DOMAIN: "https://identity.example.test/x/y?z=1#f" } as Env),
    ).toBe("https://identity.example.test");
  });

  it("treats anything that is not an https origin as unconfigured", () => {
    for (const bad of [
      "http://identity.example.test",
      "javascript://identity.example.test",
      "https://user:pass@identity.example.test",
      "user@identity.example.test",
      "https://",
    ]) {
      expect(authkitDomain({ WORKOS_AUTHKIT_DOMAIN: bad } as Env), bad).toBeNull();
      expect(() => normaliseAuthkitDomain(bad)).toThrow("WORKOS_AUTHKIT_DOMAIN is not configured");
    }
  });

  it("fails closed with 503 on /authorize and /callback when unset or not https", async () => {
    for (const env of [{}, { WORKOS_AUTHKIT_DOMAIN: "http://identity.example.test" }]) {
      for (const path of ["/authorize", "/callback"]) {
        const res = await AuthkitHandler.request(`https://mongodb.nyuchi.dev${path}`, {}, env);
        expect(res.status).toBe(503);
        expect(await res.text()).toContain("WORKOS_AUTHKIT_DOMAIN is not configured");
      }
    }
  });
});

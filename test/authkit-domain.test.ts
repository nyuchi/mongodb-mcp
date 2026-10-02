import { describe, expect, it } from "vitest";
import { AuthkitHandler, authkitDomain } from "../src/authkit-handler";

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

  it("fails closed with 503 on /authorize and /callback when unset", async () => {
    for (const path of ["/authorize", "/callback"]) {
      const res = await AuthkitHandler.request(`https://mongodb.nyuchi.dev${path}`, {}, {});
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("WORKOS_AUTHKIT_DOMAIN is not configured");
    }
  });
});

import { describe, expect, it } from "vitest";
import { checkAccess } from "../src/authkit-handler";

const ORG = "org_live";
const PERMISSION = "mongodb:access";
const configured = { allowedOrgIds: ORG, requiredPermission: PERMISSION };
const authorized = { organizationId: ORG, permissions: [PERMISSION] };

describe("checkAccess", () => {
  it("admits a session in an allowed org holding the required permission", () => {
    expect(checkAccess(configured, authorized)).toBeNull();
  });

  it("reads the org allowlist as comma-separated, tolerating whitespace", () => {
    const config = { ...configured, allowedOrgIds: " org_a , org_live ,org_b " };
    expect(checkAccess(config, authorized)).toBeNull();
    expect(checkAccess(config, { ...authorized, organizationId: "org_b" })).toBeNull();
    expect(checkAccess(config, { ...authorized, organizationId: "org_other" })?.status).toBe(403);
  });

  // The gate exists to keep every other org out. If a deployment forgets the
  // config, "no restriction" is the one interpretation that must never apply:
  // it would admit any WorkOS user of any organization to the tool surface.
  describe("fails closed when unconfigured", () => {
    for (const allowedOrgIds of [undefined, "", "   ", ",", " , , "]) {
      it(`refuses when WORKOS_ALLOWED_ORG_IDS is ${JSON.stringify(allowedOrgIds)}`, () => {
        const denial = checkAccess({ ...configured, allowedOrgIds }, authorized);
        expect(denial).not.toBeNull();
        expect(denial!.status).toBe(500);
        expect(denial!.message).toContain("WORKOS_ALLOWED_ORG_IDS");
      });
    }

    for (const requiredPermission of [undefined, "", "   "]) {
      it(`refuses when WORKOS_REQUIRED_PERMISSION is ${JSON.stringify(requiredPermission)}`, () => {
        const denial = checkAccess({ ...configured, requiredPermission }, authorized);
        expect(denial).not.toBeNull();
        expect(denial!.status).toBe(500);
        expect(denial!.message).toContain("WORKOS_REQUIRED_PERMISSION");
      });
    }

    it("refuses when neither is configured", () => {
      expect(checkAccess({}, authorized)?.status).toBe(500);
    });
  });

  describe("rejects sessions that miss either gate", () => {
    it("refuses an org outside the allowlist", () => {
      const denial = checkAccess(configured, { ...authorized, organizationId: "org_intruder" });
      expect(denial?.status).toBe(403);
      expect(denial?.message).toContain("organization is not authorized");
    });

    it("refuses a session carrying no org at all", () => {
      const denial = checkAccess(configured, { ...authorized, organizationId: undefined });
      expect(denial?.status).toBe(403);
    });

    it("refuses when the required permission is absent", () => {
      const denial = checkAccess(configured, { ...authorized, permissions: [] });
      expect(denial?.status).toBe(403);
      expect(denial?.message).toContain(PERMISSION);
    });

    it("refuses when only unrelated permissions were granted", () => {
      const denial = checkAccess(configured, {
        ...authorized,
        permissions: ["openid", "email", "profile", "mongodb:read"],
      });
      expect(denial?.status).toBe(403);
    });

    it("does not accept a permission by prefix or substring", () => {
      for (const granted of ["mongodb:acces", "mongodb:access:admin", "xmongodb:access"]) {
        expect(checkAccess(configured, { ...authorized, permissions: [granted] })?.status).toBe(
          403,
        );
      }
    });

    it("checks the org before the permission, so an outsider is never told which permission to seek", () => {
      const denial = checkAccess(configured, { organizationId: "org_intruder", permissions: [] });
      expect(denial?.message).not.toContain(PERMISSION);
    });
  });
});

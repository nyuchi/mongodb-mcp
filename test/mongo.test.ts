import { ObjectId } from "bson";
import { describe, expect, it } from "vitest";
import { parseExtendedJson, stringifyEJson } from "../src/ejson";

describe("parseExtendedJson", () => {
  it("returns the same value for null / undefined", () => {
    expect(parseExtendedJson(null)).toBeNull();
    expect(parseExtendedJson(undefined)).toBeUndefined();
  });

  it("parses Extended JSON strings into BSON types", () => {
    const oidHex = "507f1f77bcf86cd799439011";
    const parsed = parseExtendedJson<{ _id: ObjectId }>(`{"_id": {"$oid": "${oidHex}"}}`);
    expect(parsed._id).toBeInstanceOf(ObjectId);
    expect(parsed._id.toHexString()).toBe(oidHex);
  });

  it("coerces $oid markers in plain JS objects too", () => {
    const oidHex = "507f1f77bcf86cd799439011";
    const parsed = parseExtendedJson<{ _id: ObjectId }>({ _id: { $oid: oidHex } });
    expect(parsed._id).toBeInstanceOf(ObjectId);
    expect(parsed._id.toHexString()).toBe(oidHex);
  });

  it("passes through plain documents", () => {
    const parsed = parseExtendedJson<{ name: string; age: number }>({ name: "ada", age: 36 });
    expect(parsed).toEqual({ name: "ada", age: 36 });
  });
});

describe("stringifyEJson", () => {
  it("renders BSON ObjectIds as hex (relaxed mode)", () => {
    const oid = new ObjectId("507f1f77bcf86cd799439011");
    const text = stringifyEJson({ _id: oid });
    expect(text).toContain("507f1f77bcf86cd799439011");
  });

  it("truncates outputs larger than 256KiB", () => {
    const big = { blob: "x".repeat(300 * 1024) };
    const text = stringifyEJson(big);
    expect(text.length).toBeLessThanOrEqual(256 * 1024 + 100);
    expect(text).toContain("[truncated,");
  });
});

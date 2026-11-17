import { describe, expect, it } from "vitest";
import { buildKey, parseKey } from "../src/server/tickets/keys.js";

describe("buildKey", () => {
  it("joins the prefix and the number with a dash", () => {
    expect(buildKey("SUP", 42)).toBe("SUP-42");
  });
});

describe("parseKey", () => {
  it("round trips with buildKey", () => {
    for (const id of [1, 9, 10, 42, 123456]) {
      expect(parseKey("SUP", buildKey("SUP", id))).toBe(id);
    }
  });

  it.each([
    ["wrong prefix", "ABC-42"],
    ["lower case prefix", "sup-42"],
    ["bare number", "42"],
    ["no number", "SUP-"],
    ["no dash", "SUP42"],
    ["non-numeric", "SUP-abc"],
    ["mixed digits and letters", "SUP-4x"],
    ["zero", "SUP-0"],
    ["negative", "SUP--1"],
    ["leading zero", "SUP-042"],
    ["decimal", "SUP-4.5"],
    ["space inside", "SUP- 42"],
    ["trailing text", "SUP-42 "],
    ["number too large to be exact", "SUP-99999999999999999999"],
    ["empty string", ""],
  ])("returns null for %s", (_name, key) => {
    expect(parseKey("SUP", key)).toBeNull();
  });

  it("uses the prefix it is given", () => {
    expect(parseKey("HELP", "HELP-7")).toBe(7);
    expect(parseKey("HELP", "SUP-7")).toBeNull();
  });
});

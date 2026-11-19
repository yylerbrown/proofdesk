import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The theme keeps a colour for a status badge only while the stylesheet still draws it.

describe("the status badge colours", () => {
  it("are each read by the stylesheet", () => {
    const theme = fs.readFileSync("public/theme.css", "utf8");
    const site = fs.readFileSync("public/site.css", "utf8");
    const tokens = [...theme.matchAll(/(--pd-badge-[\w-]+):/g)].map((match) => match[1]!);
    expect(tokens.length).toBeGreaterThan(0);
    const unread = tokens.filter((token) => !site.includes(`var(${token})`));
    expect(unread).toEqual([]);
  });
});

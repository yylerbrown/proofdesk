import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The README says once, beside the production site's address, how sign-in works there, and its
// walkthrough says exactly how the proof step's sample suggestions look.

const readme = fs.readFileSync("README.md", "utf8");
const flat = readme.replace(/\s+/g, " ");

describe("the README", () => {
  it("says beside the production site that people sign in with GitHub and start as customers", () => {
    expect(flat).toContain(
      "**The production site: <https://proofdesk.fly.dev>.** People sign in with GitHub and start as customers.",
    );
    expect(flat.match(/start as customers/g)).toHaveLength(1);
  });

  it("describes the proof step's sample suggestions as they are drawn", () => {
    expect(flat).toContain(
      'with three sample suggestions as "+" buttons, the first already added to the box.',
    );
    expect(flat).not.toContain('three sample "+" suggestions');
  });
});

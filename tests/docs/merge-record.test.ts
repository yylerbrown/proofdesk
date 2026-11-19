import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The working rules say how a change reaches main. They must state the rule and its exceptions
// once each, without a promise the record breaks, and agree with the specification's account.

function reviewSection(): string {
  const text = fs.readFileSync("AGENTS.md", "utf8");
  const start = text.indexOf("## Review");
  return text.slice(start).replace(/\s+/g, " ");
}

describe("the merge record in AGENTS.md", () => {
  it("says checks gate every merge, without promising that GitHub's CI did", () => {
    const review = reviewSection();
    expect(review).toContain("Checks gate every merge but one");
    expect(review).not.toMatch(/Nothing merges before CI passes/i);
  });

  it("keeps the dated merge history in the specification, not in the working rules", () => {
    const review = reviewSection();
    expect(review.match(/#\d+/g)).toBeNull();
    expect(review).not.toMatch(/\d{1,2}:\d{2} UTC|\d+ November/);
    expect(review).toContain("`docs/SPEC.md`");
    const spec = fs.readFileSync("docs/SPEC.md", "utf8");
    for (const exception of ["#1", "#96"]) expect(spec).toContain(exception);
  });

  it("is what the README's verification section points to, with the local gate", () => {
    const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    const start = readme.indexOf("## How it is verified");
    const section = readme.slice(start, readme.indexOf(" ## ", start + 1));
    expect(section).toContain("](AGENTS.md)");
    expect(section).toContain("local gate");
    expect(section).not.toContain("CI runs all of them on every pull request");
    // The dated history of how CI stopped is process detail a first reader does not need.
    expect(section).not.toContain("GitHub's CI ran them until");
    expect(section).toContain("](docs/SPEC.md#standing-rules)");
    expect(section).not.toContain("the public copy's");
  });
});

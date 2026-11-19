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

  it("names the same exceptions as the specification", () => {
    const named = [...reviewSection().matchAll(/#(\d+)/g)].map((m) => m[1]);
    expect(named).toEqual(["1", "96"]);
    const spec = fs.readFileSync("docs/SPEC.md", "utf8");
    for (const number of named) expect(spec).toContain(`#${number}`);
  });

  it("is what the README's verification section points to, with the local gate", () => {
    const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    const start = readme.indexOf("## How it is verified");
    const section = readme.slice(start, readme.indexOf(" ## ", start + 1));
    expect(section).toContain("](AGENTS.md)");
    expect(section).toContain("local gate");
    expect(section).not.toContain("CI runs all of them on every pull request");
  });
});

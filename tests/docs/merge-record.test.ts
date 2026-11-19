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

  it("keeps the dated merge history in the build log, not in the working rules", () => {
    const review = reviewSection();
    expect(review.match(/#\d+/g)).toBeNull();
    expect(review).not.toMatch(/\d{1,2}:\d{2} UTC|\d+ November/);
    // Who merged and reviewed this build is history, not a rule for the next assistant.
    expect(review).not.toContain("coordinating assistant");
    expect(review).toContain("`docs/BUILD_LOG.md`");
    const log = fs.readFileSync("docs/BUILD_LOG.md", "utf8");
    const start = log.indexOf("## How changes reached main");
    expect(start).toBeGreaterThan(0);
    const history = log.slice(start, log.indexOf("\n## ", start + 1)).replace(/\s+/g, " ");
    for (const exception of ["#1", "#96"]) expect(history).toContain(exception);
    expect(history).toContain("private repository");
    expect(history).toContain("`docs/PULL_REQUESTS.md`");
    expect(history).toContain("coordinating assistant");
    expect(history).toContain("no human reviewer");
    const spec = fs.readFileSync("docs/SPEC.md", "utf8");
    for (const exception of ["#1", "#96"]) expect(spec).toContain(exception);
  });

  // The README gives the test command. How merges were gated is process history, kept in the
  // build log, and the working rules are for coding assistants, not a first reader.
  it("stays out of the README, which names the checks and leaves the history to the build log", () => {
    const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    const start = readme.indexOf("## Tests");
    expect(start).toBeGreaterThan(0);
    const section = readme.slice(start, readme.indexOf(" ## ", start + 1));
    expect(section).toContain("npm test");
    expect(section).not.toContain("local gate");
    expect(section).not.toContain("GitHub's CI ran them until");
    expect(readme).not.toContain("](AGENTS.md)");
    expect(readme).not.toContain("the one exception");
    expect(readme).not.toContain("the public copy's");
  });
});

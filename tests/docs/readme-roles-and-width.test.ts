import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The README's roles paragraph says what a refusal shows, and the sections changed with the role
// work keep their prose within 100 columns like the guides.

const readme = fs.readFileSync("README.md", "utf8");

function section(heading: string): string {
  const start = readme.indexOf(`${heading}\n`);
  const end = readme.indexOf("\n## ", start + heading.length);
  return readme.slice(start, end === -1 ? undefined : end);
}

describe("the README", () => {
  it("says a ticket action refused for the role names who may and links Who may do what", () => {
    const roles = section("## Sign-in and roles").replace(/\s+/g, " ");
    expect(roles).toContain(
      "A ticket action refused for the role names who may and links **Who may do what**.",
    );
    // Not every refusal: other refusals have their own words, so the README must not say all do.
    expect(roles).not.toContain("A refusal names who may");
    const errors = fs.readFileSync("src/server/errors.ts", "utf8");
    expect(errors).toContain("Who may: ${whoMay}");
    expect(errors).toContain("It says who may only when the role is the");
    expect(fs.readFileSync("src/server/tickets/checks.ts", "utf8")).toContain(
      "throw forbidden(actor, action);",
    );
  });

  it("says the model calls left out are the product's, not a board's", () => {
    const limits = section("## Known limits");
    expect(limits).toContain("and model calls of Proofdesk's own.");
    expect(limits).not.toContain("model calls of its own");
  });

  it("keeps the prose of the roles, assistant, Read first and limits sections within 100 columns", () => {
    for (const heading of [
      "## Sign-in and roles",
      "## The AI assistant",
      "## Read first",
      "## Known limits",
    ]) {
      const prose = section(heading)
        .split("\n")
        .filter((line) => !line.startsWith("|") && !line.startsWith("<img"));
      for (const line of prose) expect(line.length, `${heading}: ${line}`).toBeLessThanOrEqual(100);
    }
  });
});

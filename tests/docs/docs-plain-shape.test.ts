import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { errorOutput } from "../../src/server/api/schemas.js";

// The guides a reader meets keep one plain shape: each opens by saying what it is for, an
// example comes before the explanation it shows, settings and fields sit in tables, and no
// guide grows past the length it had when this shape was set (counted as the README's cap is,
// so a file's last line break counts as one more line).

const read = (file: string) => fs.readFileSync(file, "utf8");

/** The first paragraph under a page's title. */
function opening(file: string): string {
  const text = read(file);
  return text.slice(text.indexOf("\n\n") + 2).split("\n\n")[0]!;
}

/** One section of a page, from its heading to the next one at the same level. */
function section(file: string, heading: string): string {
  const text = read(file);
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(0);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("the guides' shape", () => {
  it.each([
    ["docs/API.md", "This page is"],
    ["docs/TOUR.md", "This page shows"],
    ["docs/DEPLOY.md", "This page runs"],
    ["docs/AGENTS_GUIDE.md", "This guide connects"],
  ])("%s opens by saying what it is for, in two lines", (file, words) => {
    const first = opening(file);
    expect(first.startsWith(words)).toBe(true);
    expect(first.split("\n").length).toBeLessThanOrEqual(3);
  });

  it.each([
    ["docs/API.md", "## Trying it with curl", "## Routes"],
    ["docs/AGENTS_GUIDE.md", "## A worked example", "## The one path"],
  ])("%s shows its example before the explanation", (file, example, explanation) => {
    const text = read(file);
    expect(text.indexOf(example)).toBeGreaterThan(0);
    expect(text.indexOf(example)).toBeLessThan(text.indexOf(explanation));
  });

  it("gives every field of an API error a row in the reference's table", () => {
    const errors = section("docs/API.md", "## Errors");
    const fields = Object.keys(errorOutput.shape.error.shape).filter(
      (name) => name !== "code" && name !== "message",
    );
    for (const name of fields)
      expect(errors, name).toMatch(new RegExp(`^\\| \`${name}\` +\\|`, "m"));
    expect(errors).toContain('{ "error": { "code", "message", "hint", "retry" } }');
  });

  it("puts the roles in a table in the README", () => {
    const roles = section("README.md", "## Sign-in and roles");
    for (const role of ["Customer", "Team member", "Admin"])
      expect(roles).toMatch(new RegExp(`^\\| ${role} +\\|`, "m"));
  });

  it("lists the ways to ask Proofdesk itself in a table, with the page for assistants first", () => {
    const ask = section("docs/AGENTS_GUIDE.md", "## Ask Proofdesk itself");
    const rows = [...ask.matchAll(/^\| `([^`]+)` +\|/gm)].map((m) => m[1]);
    expect(rows).toEqual(["/llms.txt", "GET /api", "GET /api/openapi.json"]);
  });

  it.each([
    ["README.md", 175],
    ["docs/API.md", 96],
    ["docs/AGENTS_GUIDE.md", 174],
    ["docs/TOUR.md", 57],
    ["docs/DEPLOY.md", 326],
  ])("%s is no longer than it was", (file, lines) => {
    expect(read(file).split("\n").length).toBeLessThanOrEqual(lines);
  });

  it("names features, not categories, in the tour's headings", () => {
    const headings = [...read("docs/TOUR.md").matchAll(/^\*\*([^*]+)\*\*$/gm)].map((m) => m[1]);
    expect(headings.filter((h) => /creative|extras|SSO/i.test(h!))).toEqual([]);
  });

  it("shows the agents guide's open addresses before the sentence about them", () => {
    const part = section("docs/AGENTS_GUIDE.md", "## Ask Proofdesk itself");
    const body = part.slice(part.indexOf("\n", 1)).trim();
    expect(body.startsWith("| Address")).toBe(true);
    expect(part.indexOf("| `/llms.txt`")).toBeLessThan(part.indexOf("None of these needs a key."));
  });
});

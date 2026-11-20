import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The README is for a reader with five minutes: what the product is, how to run it, one ticket
// from New to Resolved, the tests, the roles, the assistant, and the limits. Everything else
// lives in a guide under docs/, linked from it, so the README stays about two screens long.

const readme = fs.readFileSync("README.md", "utf8");
const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);

describe("the README", () => {
  it("keeps to the sections a first reader needs, in this order", () => {
    expect(headings).toEqual([
      "Run it yourself",
      "One ticket, start to finish",
      "Tests",
      "Sign-in and roles",
      "The AI assistant",
      "Read first",
      "How the work was directed",
      "Known limits",
      "More",
    ]);
  });

  it("is short enough to read in five minutes", () => {
    expect(readme.split("\n").length).toBeLessThanOrEqual(175);
  });

  it("walks one ticket from filing to the customer's Yes", () => {
    const start = readme.indexOf("## One ticket, start to finish");
    const walk = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const order = [
      "**File a sample ticket**",
      "**File ticket**",
      "**Save**",
      "**Take ticket and start work**",
      "**Mark fixed and tell the customer**",
      "**Yes, it is fixed**",
      "Resolved, customer confirmed",
      "`Resolved by the team: <reason>`",
    ].map((text) => walk.replace(/\s+/g, " ").indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leads the assistant section with the recorded run", () => {
    const start = readme.indexOf("## The AI assistant");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const firstParagraph = section.split("\n\n")[1]!;
    expect(firstParagraph).toContain("/assistant-run");
    expect(section).toContain("](docs/AGENTS_GUIDE.md)");
  });

  it("leaves the settings, Docker, the MCP setup and the feature tour to the guides", () => {
    expect(readme).not.toContain("### Settings");
    expect(readme).not.toContain("docker run");
    expect(readme).not.toContain("claude mcp add");
    expect(readme).not.toContain("## Try each feature in a minute");
    expect(readme).toContain("](docs/TOUR.md)");
    expect(readme).toContain("](docs/DEPLOY.md#more-ways-to-run)");
  });

  it("does not send a first reader to the coding assistants' working rules", () => {
    const start = readme.indexOf("## Read first");
    const readFirst = readme.slice(start, readme.indexOf("\n## ", start + 1));
    expect(readFirst).not.toContain("AGENTS.md");
  });
});

describe("the deploy guide's settings", () => {
  it("lists every variable in .env.example", () => {
    const names = [
      ...fs.readFileSync(".env.example", "utf8").matchAll(/^#? ?([A-Z][A-Z_]{2,})=/gm),
    ].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    const deploy = fs.readFileSync("docs/DEPLOY.md", "utf8");
    const start = deploy.indexOf("### Settings");
    const table = deploy.slice(start, deploy.indexOf("\n### ", start + 1));
    for (const name of new Set(names)) expect(table, name).toContain(`\`${name}\``);
  });
});

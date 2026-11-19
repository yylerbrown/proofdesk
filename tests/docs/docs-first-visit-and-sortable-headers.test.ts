import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { llmsText } from "../../src/server/api/llms-text.js";
import { LIST_SORTS, SORT_DIRECTIONS } from "../../src/server/tickets/schemas.js";

// The demo now opens on the ticket list as the customer, with one welcome card, and the old
// page of choices is "About this demo". The list sorts by its column headers instead of the
// order links that sat under it. The docs must say what a visitor presses now.

const flat = (file: string) => fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
const readme = flat("README.md");

/** One section of a Markdown file, from its heading to the next heading of the same level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = heading.split(" ")[0]!;
  const next = text.indexOf(`\n${level} `, start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe("the first visit, as the docs describe it", () => {
  const visitorDocs = [
    "README.md",
    "docs/TOUR.md",
    "docs/AGENTS_GUIDE.md",
    "docs/DEPLOY.md",
    "docs/API.md",
  ];

  it("never sends a visitor to the old welcome page or its button", () => {
    for (const file of visitorDocs) {
      const text = flat(file);
      expect(text, file).not.toMatch(/welcome page/i);
      expect(text, file).not.toContain("Try the ticket workflow");
    }
  });

  it("starts the README's walkthrough from the welcome card on the customer's list", () => {
    const walk = section(fs.readFileSync("README.md", "utf8"), "## One ticket, start to finish");
    expect(walk.replace(/\s+/g, " ")).toContain(
      "The demo opens on your ticket list as the Demo Customer. On the welcome card above the list, press **File a sample ticket**",
    );
  });

  it("sends a visitor to About this demo for the roles' note and the assistant key", () => {
    expect(readme).toContain("**About this demo**, in every page's footer");
    expect(readme).toContain(
      "open **About this demo** from the demo's footer, then **Connect your own AI assistant** and **Get a demo connection**",
    );
    expect(flat("docs/AGENTS_GUIDE.md")).toContain(
      "Open **About this demo** in the footer, then **Connect your own AI assistant**",
    );
    expect(flat("docs/TOUR.md")).toContain("- Start as: **About this demo**");
  });

  it("tells an assistant where a demo key comes from", () => {
    const page = llmsText("https://demo.example");
    expect(page).toContain("**Get a demo connection** on the About this demo page");
    expect(page).not.toMatch(/welcome page/i);
  });

  it("records the change in the specification", () => {
    const entry = section(
      fs.readFileSync("docs/SPEC.md", "utf8"),
      "### 2026-11-18, night: the demo opens on the list, and the list sorts by its headers",
    );
    expect(entry).toContain("**File a sample ticket**");
    expect(entry).toContain("**About this demo**");
    expect(entry).toContain("`sort` and `direction`");
  });
});

describe("the sortable headers, as the docs describe them", () => {
  it("never name the order links that were under the table", () => {
    for (const file of ["README.md", "docs/TOUR.md", "docs/PRODUCTION_CHECKLIST.md"]) {
      const text = flat(file);
      expect(text, file).not.toContain("Oldest first");
      expect(text, file).not.toContain("Recently updated");
      expect(text, file).not.toContain("order choice");
    }
  });

  it("tell a visitor to press a header, and a second press reverses it", () => {
    const tour = flat("docs/TOUR.md");
    expect(tour).toContain("a column header such as **Title** or **Filed**");
    expect(tour).toContain("a second press reverses it");
    expect(tour).toContain('"Sort by" line');
  });

  it("list every sort and both directions where the API's list is described", () => {
    const row = fs
      .readFileSync("docs/API.md", "utf8")
      .split("\n")
      .find((line) => line.startsWith("| `GET /api/tickets`"))!;
    expect(row).toContain("`sort`");
    expect(row).toContain("`direction`");
    for (const sort of LIST_SORTS) expect(row, sort).toContain(`\`${sort}\``);
    for (const direction of SORT_DIRECTIONS) expect(row, direction).toContain(`\`${direction}\``);
  });

  it("caption the list's picture as the team member's view, with no welcome card", () => {
    const tag = /<img src="docs\/img\/ticket-list.png"[^>]*>/.exec(readme)![0];
    expect(tag).toContain("team member's ticket list");
    expect(tag).toContain("no welcome card");
    expect(tag).toContain("column headers that sort the list");
  });
});

describe("the build log", () => {
  it("has a row for each pull request merged on the night of 18 November, in merge order", () => {
    const log = fs.readFileSync("docs/BUILD_LOG.md", "utf8");
    const merged = [162, 163, 164, 165];
    const at = merged.map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

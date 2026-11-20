import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CUSTOMER_ANSWER_TAG } from "../../src/server/pages/format.js";

// The last two finishing passes made marking fixed the team member's agreement that the
// customer's proof was met, added an age filter for resolved tickets, and renamed a few lines.
// Each check ties a docs sentence to the view or the record it describes.

const read = (file: string) => fs.readFileSync(file, "utf8");
const flat = (file: string) => read(file).replace(/\s+/g, " ");
const tour = flat("docs/TOUR.md");
const spec = flat("docs/SPEC.md");

describe("marking fixed, in the docs", () => {
  it("is named as the team's agreement, with History's words as the view writes them", () => {
    const history =
      "Resolved by the team: Fixed. Agreed that what would prove it is fixed was met. Not customer-confirmed.";
    expect(read("src/server/pages/format.ts")).toContain(history);
    expect(tour).toContain(`History records "${history}"`);
    expect(spec).toContain(`History reads "${history}"`);
    expect(spec).toContain("### 2026-11-19, night: marking fixed is the team's agreement");
    expect(flat("README.md")).toContain(
      "**Mark fixed and tell the customer**, agreeing the proof above it was met",
    );
  });

  it("says the bulk bar offers the two reasons the list's route gives it", () => {
    const pages = read("src/server/routes/pages.ts");
    const bulk = /const BULK_RESOLVE_REASONS = \{([^}]*)\}/.exec(pages)![1]!;
    expect(bulk.match(/RESOLVE_REASON_LABELS\./g)).toHaveLength(2);
    expect(bulk).toContain("wont_fix");
    expect(bulk).toContain("cannot_reproduce");
    expect(tour).toContain("Resolved there offers two reasons, Won't fix and Cannot reproduce");
  });
});

describe("the list's words, in the tour", () => {
  it("names the age filter's labels and addresses as the view draws them", () => {
    const list = read("views/ticket-list.ejs");
    expect(list).toContain('[["any", "Any age"], ["recent", "Last 14 days"], ["older", "Older"]]');
    expect(tour).toContain("a small group reads **Any age**, **Last 14 days** and **Older**");
    expect(tour).toContain("`?resolved=recent` or `?resolved=older`");
    expect(tour).not.toContain('"Resolved:"');
    expect(tour).not.toContain("resolved=any");
    expect(tour).not.toContain("a line under the list says how many older resolved tickets");
  });

  it("quotes the customer's tag, the marks' legend and the one-time line after a switch", () => {
    expect(tour).toContain(`tagged "${CUSTOMER_ANSWER_TAG}"`);
    const list = read("views/ticket-list.ejs");
    for (const words of ["Says what would prove it is fixed", "Customer confirmed"]) {
      expect(list).toContain(`</span> ${words}</span>`);
      expect(tour).toContain(`"${words}"`);
    }
    expect(read("src/server/pages/saved.ts")).toContain("return `You are now ${name}.`;");
    expect(tour).toContain('the next page says once "You are now Demo Team Member."');
  });
});

describe("the records", () => {
  it("say which faults from the dogfooding run were fixed afterwards", () => {
    const summary = flat("docs/dogfood-run/summary.md");
    expect(summary).toContain("Fixed afterwards, in pull request #203: the first four.");
    expect(summary).toContain("seven hours behind UTC");
  });

  it("give the build log a row for each later pull request, in merge order", () => {
    const log = read("docs/BUILD_LOG.md");
    const at = [202, 203, 204].map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("keep the owner's ten ideas apart from the smaller ones raised on the demo", () => {
    const roadmap = read("docs/ROADMAP.md");
    const start = roadmap.indexOf("## Smaller ideas from walking the demo");
    expect(start).toBeGreaterThan(roadmap.indexOf("## Dropped"));
    const ideas = roadmap
      .slice(start, roadmap.indexOf("## Already built"))
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(ideas).toHaveLength(14);
    expect(new Set(ideas).size).toBe(ideas.length);
  });
});

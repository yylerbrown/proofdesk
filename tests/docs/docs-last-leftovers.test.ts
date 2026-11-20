import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The last docs pass: the tour names the demo's sample batch as the view draws it, the age
// filter is described as appearing only under Resolved, a roadmap line
// lost a promise the product does not plan, prose fits the files' width, and the build log
// has a row for each pull request merged since its last row.

const read = (file: string) => fs.readFileSync(file, "utf8");
const flat = (file: string) => read(file).replace(/\s+/g, " ");
const tour = flat("docs/TOUR.md");

describe("the demo's sample batch, in the tour", () => {
  it("quotes the form's line, labels and button as the view draws them", () => {
    const view = read("views/sign-in.ejs");
    const line = "Want a fuller list to filter, sort and search? Add sample tickets.";
    for (const words of [line, "How many", "Filed over", "Add sample tickets"]) {
      expect(view).toContain(words);
      expect(tour).toContain(words);
    }
    const periods = read("src/server/demo-sample-batch.ts");
    for (const period of ["The last week", "The last month", "The last three months"]) {
      expect(periods).toContain(`label: "${period}"`);
      expect(tour).toContain(`"${period}"`);
    }
    expect(tour).toContain("10, 25 or 50");
    expect(tour).toContain("stops while room remains for visitors' own tickets");
  });
});

describe("the age filter, in the tour and the spec", () => {
  it("appears only under Resolved, and All shows every ticket", () => {
    expect(tour).toContain("Under **Resolved**, with nothing searched, a small group reads");
    expect(tour).toContain("**All** shows every ticket");
    const spec = flat("docs/SPEC.md");
    expect(spec).toContain("Under Resolved, with nothing searched, a small group offers Any age");
    expect(spec).toContain("### 2026-11-20: Edit beside the title, and Open on the list");
    for (const file of [tour, spec, flat("README.md")]) {
      expect(file).not.toContain('"Resolved:" filter');
      expect(file).not.toContain("leaves out tickets resolved more than 14 days ago");
    }
  });
});

describe("the roadmap", () => {
  it("names a ticket's real age on the list, without the age of its last reply", () => {
    const roadmap = read("docs/ROADMAP.md");
    expect(roadmap).toContain("- Each ticket's real age on the list.\n");
    expect(roadmap).not.toContain("beside the age of its last reply");
  });
});

describe("prose in the agent guide and the architecture notes", () => {
  it("fits within 100 columns outside tables and code", () => {
    for (const file of ["docs/AGENTS_GUIDE.md", "docs/ARCHITECTURE.md"]) {
      let inCode = false;
      for (const line of read(file).split("\n")) {
        if (line.startsWith("```")) inCode = !inCode;
        if (inCode || line.trimStart().startsWith("|")) continue;
        expect(line.length, `${file}: ${line.slice(0, 40)}`).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("the build log", () => {
  it("has rows for #206, #205, #207 and #208, in the order they merged", () => {
    const log = read("docs/BUILD_LOG.md");
    const at = [204, 206, 205, 207, 208].map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

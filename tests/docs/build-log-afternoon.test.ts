import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The build log stays current, and the docs speak to a user of the product or a reader of the
// code: each row says what its change did for them.

const log = fs.readFileSync("docs/BUILD_LOG.md", "utf8");

describe("the build log", () => {
  it("has a row for each pull request merged on the afternoon of 20 November", () => {
    for (const pr of ["#214", "#215", "#216", "#217", "#218", "#220", "#221"]) {
      expect(log).toMatch(new RegExp(`\\| ${pr} +\\|`));
    }
  });

  it("lists the last rows in merge order, each with its own step number", () => {
    const rows = log.split("\n").filter((line) => /^\| 20[0-9]\. /.test(line));
    const order = rows.map((line) => [/^\| (\d+)\./.exec(line)![1], /(#\d+) +\|$/.exec(line)![1]]);
    expect(order).toEqual([
      ["200", "#214"],
      ["201", "#215"],
      ["202", "#216"],
      ["203", "#218"],
      ["204", "#217"],
      ["205", "#220"],
      ["206", "#221"],
      ["207", "#219"],
    ]);
  });

  it("keeps the pull request numbers of the rows reworded for a user or a reader", () => {
    const titles: Record<string, string> = {
      "#57": "49. Labels a first visit can follow",
      "#60": "52. A README that walks each feature",
      "#78": "70. Links to the source and the real site",
      "#79": "71. A workflow a visitor can finish",
    };
    for (const [pr, title] of Object.entries(titles)) {
      const row = log.split("\n").find((line) => line.startsWith(`| ${title} `));
      expect(row, title).toMatch(new RegExp(`\\| ${pr} +\\|$`));
    }
  });
});

describe("the docs", () => {
  it("say what each change did for a user or a reader", () => {
    const docs = ["README.md", ...fs.readdirSync("docs").filter((f) => f.endsWith(".md"))];
    for (const file of docs) {
      const text = fs.readFileSync(file === "README.md" ? file : `docs/${file}`, "utf8");
      expect(text, file).not.toMatch(/\b(grader|rubric)s?\b/i);
      expect(text, file).not.toContain("The brief asks");
    }
  });
});

import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The roadmap puts regression tests first, keeps the agreed order for after sending, says what
// was dropped and why, and does not offer as new what is already built. The README's "What's
// next" names only the first item.

const roadmap = fs.readFileSync("docs/ROADMAP.md", "utf8");
const section = (from: string, to: string) =>
  roadmap.slice(roadmap.indexOf(from), to ? roadmap.indexOf(to) : undefined);
const rows = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.includes("---"))
    .slice(1)
    .map((line) => line.split("|").map((cell) => cell.trim()));

describe("the roadmap", () => {
  it("starts with regression tests, by permanent scenario id, the desk keeping only what was reported", () => {
    const first = section("## First:", "## After sending");
    expect(first).toContain("`SUP-42/S1`");
    expect(first.replace(/\s+/g, " ")).toContain('records only "Reported passing at commit <sha>"');
    expect(first.replace(/\s+/g, " ")).toContain(
      "marks a test retired only when the repository's owner says so",
    );
  });

  it("keeps the agreed order after sending, and says what was dropped", () => {
    const order = rows(section("## After sending", "## Dropped")).map((cells) => cells[2]);
    expect(order).toEqual([
      "Regression tests",
      "Agent comments at three moments",
      "Photos and video",
      "Search",
      "Agent descriptions with versions",
      "Reports",
      "A budget",
      "The top bar",
    ]);
    const dropped = rows(section("## Dropped", "## Already built")).map((cells) => cells[1]);
    expect(dropped).toEqual(["The list as an accordion", '"Agent tooling" as the umbrella']);
  });

  it("names what is already built", () => {
    const built = section("## Already built", "");
    for (const thing of [
      "owner",
      "hand-off",
      "internal notes",
      "Evidence",
      "Test specs",
      "blocked",
    ]) {
      expect(built, thing).toContain(thing);
    }
  });
});

describe("the README's What's next", () => {
  it("has one line: the regression tests", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const next = readme.slice(readme.indexOf("## What's next"));
    const body = next.slice(
      next.indexOf("\n") + 1,
      next.indexOf("\n## ") === -1 ? undefined : next.indexOf("\n## "),
    );
    const lines = body.split("\n").filter((line) => line.trim() !== "");
    expect(lines.join(" ")).toContain("`SUP-42/S1`");
    expect(lines.join(" ")).toContain("docs/ROADMAP.md");
  });
});

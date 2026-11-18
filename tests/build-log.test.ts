import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The build log is evidence a reader may check, so each row must name the pull request that
// carried it, each step number must be used once and in order, and every gap must be explained.

const text = fs.readFileSync("BUILD_LOG.md", "utf8");
const rows = text
  .split("\n")
  .filter((line) => /^\| \d+[a-z]?\. /.test(line))
  .map((line) => {
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
    const [, number, letter] = /^(\d+)([a-z]?)\./.exec(cells[0]!)!;
    return {
      step: `${number}${letter}`,
      number: Number(number),
      letter: letter ?? "",
      pr: cells[3]!,
    };
  });
const notes = text.slice(text.indexOf("## Notes on the numbering"));

describe("the build log", () => {
  it("names a real pull request on every row but the skeleton's", () => {
    expect(rows.length).toBeGreaterThan(100);
    expect(text).not.toContain("This pull request");
    for (const row of rows.slice(1)) expect(row.pr, row.step).toMatch(/^#\d+$/);
    const prs = rows.slice(1).map((row) => row.pr);
    expect(new Set(prs).size).toBe(prs.length);
  });

  it("uses each step number once, in order", () => {
    const steps = rows.map((row) => row.step);
    expect(new Set(steps).size).toBe(steps.length);
    for (let i = 1; i < rows.length; i++) {
      const before = rows[i - 1]!;
      const row = rows[i]!;
      const inOrder =
        row.number > before.number || (row.number === before.number && row.letter > before.letter);
      expect(inOrder, `${before.step} then ${row.step}`).toBe(true);
    }
  });

  it("explains every missing step number, and no pull request is both a row and a note", () => {
    const numbers = new Set(rows.map((row) => row.number));
    const last = Math.max(...numbers);
    for (let n = 0; n <= last; n++) {
      if (!numbers.has(n)) expect(notes, `step ${n}`).toMatch(new RegExp(`\\b${n}, `));
    }
    const inRows = new Set(rows.map((row) => row.pr));
    for (const m of notes.matchAll(/#\d+/g)) expect(inRows.has(m[0]), m[0]).toBe(false);
  });
});

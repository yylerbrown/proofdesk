import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Two lines this step adds to the docs: the build log's last rows, numbered one after another in
// the order their pull requests merged (#208, then #209, then #210), and one roadmap idea.

const log = fs.readFileSync("docs/BUILD_LOG.md", "utf8");

/** The step number of the row whose pull request column is this one. */
function stepOf(pr: number): number {
  const row = log.split("\n").find((line) => new RegExp(`\\| #${pr} +\\|\\s*$`).test(line));
  expect(row, `#${pr}`).toBeDefined();
  return Number(/^\|\s*(\d+)\./.exec(row!)![1]);
}

describe("the build log's last rows", () => {
  it("have a row for #209, between #208 and #210, numbered in merge order", () => {
    expect([208, 209, 210].map(stepOf)).toEqual([194, 195, 196]);
  });
});

describe("the roadmap's smaller ideas", () => {
  it("offer the suggested proofs on the new ticket form, never holding up filing", () => {
    const roadmap = fs.readFileSync("docs/ROADMAP.md", "utf8");
    const smaller = roadmap.slice(
      roadmap.indexOf("## Smaller ideas from walking the demo"),
      roadmap.indexOf("## Already built"),
    );
    expect(smaller.replace(/\s+/g, " ")).toContain(
      "The suggested proofs offered on the new ticket form itself, once a title and a description are typed, without ever holding up filing.",
    );
  });
});

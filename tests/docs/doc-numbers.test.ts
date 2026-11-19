import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ticketServiceFiles } from "../helpers.js";

// Counts in the README and the architecture notes drifted within a day ("about 940" tests when
// a run printed 1,032). They are now bounds that stay true as the code changes, and the length
// they give the ticket service's files is checked against the files themselves.

const FILES = ["README.md", "docs/ARCHITECTURE.md"];

describe("counts in the README and the architecture notes", () => {
  it("are floors, never a number of tests or lines given as about", () => {
    for (const file of FILES) {
      const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/about [\d,]+ tests|vitest: about/);
      expect(text, file).not.toMatch(/about \d,\d{3} lines|[\d,]+-line/);
    }
  });

  it("say no file of the ticket service is over a length that none really is over", () => {
    const claims = FILES.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
      return [...text.matchAll(/none of its files is over ([\d,]+) lines/g)].map((m) =>
        Number(m[1]!.replace(/,/g, "")),
      );
    });
    expect(claims.length).toBeGreaterThan(0);
    for (const file of ticketServiceFiles()) {
      const lines = fs.readFileSync(file, "utf8").split("\n").length;
      for (const claim of claims) expect(lines, file).toBeLessThanOrEqual(claim);
    }
  });
});

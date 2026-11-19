import fs from "node:fs";
import { describe, expect, it } from "vitest";

// Counts in the README and the architecture notes drifted within a day ("about 940" tests when
// a run printed 1,032). They are now floors, "over N", which stay true as the code grows; a
// floor for the ticket service's length is checked against the file itself.

const FILES = ["README.md", "docs/ARCHITECTURE.md"];

describe("counts in the README and the architecture notes", () => {
  it("are floors, never a number of tests or lines given as about", () => {
    for (const file of FILES) {
      const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
      expect(text, file).not.toMatch(/about [\d,]+ tests|vitest: about/);
      expect(text, file).not.toMatch(/about \d,\d{3} lines|[\d,]+-line/);
    }
  });

  it("say the ticket service is over a length it really is", () => {
    const lines = fs.readFileSync("src/server/tickets/service.ts", "utf8").split("\n").length;
    for (const file of FILES) {
      const text = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
      const claims = [...text.matchAll(/over ([\d,]+) lines/g)].map((m) =>
        Number(m[1]!.replace(/,/g, "")),
      );
      expect(claims.length, file).toBeGreaterThan(0);
      for (const claim of claims) expect(lines, file).toBeGreaterThan(claim);
    }
  });
});

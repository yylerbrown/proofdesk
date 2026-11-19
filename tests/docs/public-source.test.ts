import { execFileSync } from "node:child_process";
import fs from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "../helpers.js";

// The source is read at its public copy. Nothing links to the private working repository, whose
// pull request numbers the build log keeps, saying so.

const PUBLIC = "https://github.com/yylerbrown/proofdesk";

describe("the public source", () => {
  it("is named by the guide at /api when the server knows it", async () => {
    const { app } = buildTestApp({ SOURCE_URL: PUBLIC });
    const guide = (await request(app).get("/api")).body;
    expect(guide.addresses.source).toBe(`${PUBLIC}#readme`);
    expect((await request(buildTestApp().app).get("/api")).body.addresses.source).toBeUndefined();
  });

  it("is where the README links, and what it clones", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    expect(readme).toContain(`<${PUBLIC}>`);
    expect(readme).toContain(`git clone ${PUBLIC}.git`);
    expect(readme).toMatch(/refer to the private working\s+repository/);
  });

  it("is the only repository any tracked file links to on GitHub", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((file) => file && !file.startsWith("docs/assistant-run/") && fs.existsSync(file));
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/github\.com\/[A-Za-z0-9-]+\/support-desk/);
    }
  });
});

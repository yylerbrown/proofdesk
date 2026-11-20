import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { PICTURE_LIMITS } from "../src/server/pictures/limits.js";

// The deploy notes tell the truth: a deploy by hand reports its commit like the workflow does,
// the real site's configuration does not claim the workflow deploys it, and the security notes
// name the one exception to the request size limit.

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("the deploy notes", () => {
  it("pass the commit on every deploy by hand, as the workflow does", () => {
    expect(read(".github/workflows/deploy.yml")).toContain("--build-arg GIT_COMMIT=");
    const commands = read("docs/DEPLOY.md")
      .split("\n")
      .filter((line) => line.startsWith("fly deploy --"))
      // Going back to an older release deploys an image already built, so it builds nothing.
      .filter((line) => !line.includes("--image"));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain("--build-arg GIT_COMMIT=$(git rev-parse HEAD)");
    }
  });

  it("say the workflow deploys only the demo, in the real site's configuration", () => {
    const header = read("fly.proofdesk.toml").split("\napp =")[0] ?? "";
    expect(header).toContain("fly deploy --config fly.proofdesk.toml");
    expect(header).toContain("The Deploy workflow deploys only the demo.");
  });

  it("name the picture forms as the exception to the request size limit", () => {
    const security = read("docs/SECURITY.md").replace(/\s+/g, " ");
    const megabytes = PICTURE_LIMITS.maxBytes / (1024 * 1024);
    expect(security).toContain(
      `A request body over 100 KB is refused, except the two picture forms ` +
        `(${megabytes} MB each, at most ${PICTURE_LIMITS.perMessage}).`,
    );
  });
});

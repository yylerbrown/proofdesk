import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The README and the files under docs/ link to each other and into the code. A link to a file
// that moved, or to a heading that was renamed, would send a reader nowhere.

const FILES = [
  "README.md",
  "docs/API.md",
  "docs/ARCHITECTURE.md",
  "docs/SECURITY.md",
  "docs/DEPLOY.md",
  "docs/ROADMAP.md",
  "docs/AGENTS_GUIDE.md",
];

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces as hyphens. */
function anchorOf(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
}

function anchorsIn(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  return [...text.matchAll(/^#{1,6} (.+)$/gm)].map((m) => anchorOf(m[1]!));
}

/** Every link in the file that points inside the repository, as [target file, anchor]. */
function localLinks(file: string): { target: string; anchor: string | undefined }[] {
  const text = fs.readFileSync(file, "utf8");
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  return links
    .filter((link) => !/^[a-z]+:/.test(link))
    .map((link) => {
      const [where, anchor] = link.split("#");
      const target = where ? path.normalize(path.join(path.dirname(file), where)) : file;
      return { target, anchor };
    });
}

describe("links in the README and docs", () => {
  it("point at files that exist", () => {
    for (const file of FILES) {
      for (const { target } of localLinks(file)) {
        expect(fs.existsSync(target), `${file} links to ${target}`).toBe(true);
      }
    }
  });

  it("point at headings that exist", () => {
    for (const file of FILES) {
      for (const { target, anchor } of localLinks(file)) {
        if (anchor === undefined || !target.endsWith(".md")) continue;
        expect(anchorsIn(target), `${file} links to ${target}#${anchor}`).toContain(anchor);
      }
    }
  });
});

describe("the README", () => {
  // The welcome page links to this heading, so its anchor must stay the same.
  it("has a section headed Sign-in and roles", () => {
    expect(anchorsIn("README.md")).toContain("sign-in-and-roles");
  });

  it("shows the customer's question near the top, before the run steps", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const image = readme.indexOf("](docs/img/did-this-fix-it.png)");
    expect(image).toBeGreaterThan(0);
    expect(image).toBeLessThan(readme.indexOf("## Run it yourself"));
  });

  it("says the team can resolve with a reason, and never that only the customer resolves", () => {
    const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    expect(readme).toContain("Resolved by the team: <reason>");
    expect(readme).not.toMatch(/only (the customer|their Yes) (can )?resolves?/i);
  });
});

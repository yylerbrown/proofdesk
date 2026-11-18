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

/**
 * Every link in the file that points inside the repository, as [target file, anchor]. A Markdown
 * link and an HTML picture's src both count.
 */
function localLinks(file: string): { target: string; anchor: string | undefined }[] {
  const text = fs.readFileSync(file, "utf8");
  const links = [
    ...[...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!),
    ...[...text.matchAll(/ src="([^"]+)"/g)].map((m) => m[1]!),
  ];
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

  it("shows the ticket list first, and the customer's question where it explains their answer", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const images = [...readme.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
    expect(images).toEqual(["docs/img/ticket-list.png", "docs/img/did-this-fix-it.png"]);
    const list = readme.indexOf('src="docs/img/ticket-list.png"');
    const question = readme.indexOf('src="docs/img/did-this-fix-it.png"');
    expect(list).toBeLessThan(readme.indexOf("## Run it yourself"));
    expect(question).toBeGreaterThan(readme.indexOf("**Bonus: creative extras**"));
  });

  // A wide picture pushed the run steps far down the first screen, so each one has a width.
  it("gives every picture a display width a reader's screen can hold", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const tags = [...readme.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const width = Number(/ width="(\d+)"/.exec(tag)?.[1]);
      expect(width, tag).toBeGreaterThan(0);
      expect(width, tag).toBeLessThanOrEqual(800);
      expect(tag, "every picture says what it shows").toMatch(/ alt="[^"]{20,}"/);
    }
  });

  // A stranger needs two commands first; the other ways to run sit further down.
  it("keeps Run it yourself to installing and starting, with the rest under More ways to run", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const start = readme.indexOf("## Run it yourself");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const commands = [...section.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]!.trim());
    expect(commands).toEqual(["npm ci", "DEV_SIGN_IN=on npm run dev"]);
    expect(section).toContain("http://localhost:3000");
    expect(section).toContain("](#more-ways-to-run)");
    expect(anchorsIn("README.md")).toContain("more-ways-to-run");
  });

  it("says the team can resolve with a reason, and never that only the customer resolves", () => {
    const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");
    expect(readme).toContain("Resolved by the team: <reason>");
    expect(readme).not.toMatch(/only (the customer|their Yes) (can )?resolves?/i);
  });
});

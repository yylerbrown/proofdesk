import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The last pass on the docs: the README says plainly what the product is and what it is built
// with, three claims say exactly what the code does, and the design debt list names what an
// outside review found. Each claim here is tied to the file that makes it true.

const read = (file: string) => fs.readFileSync(file, "utf8");
const flat = (file: string) => read(file).replace(/\s+/g, " ");
const readme = read("README.md");
const packageJson = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("the README's first screen", () => {
  const paragraphs = readme.split("\n\n").map((p) => p.replace(/\s+/g, " ").trim());

  it("says plainly what the product is, right under the opening and the pitch line", () => {
    expect(paragraphs[3]).toBe(
      "Proofdesk is a support desk for filing, filtering and tracking tickets through New, In Progress and Resolved. The team marks a ticket fixed, and the customer can confirm it against the proof they wrote.",
    );
    expect(read("views/ticket-show.ejs")).toContain("Mark fixed and tell the customer");
  });

  it("says the first picture is the team's list, in the team's default order", () => {
    const alt = readme.slice(readme.indexOf('src="docs/img/ticket-list.png"'));
    expect(alt).toContain("The team member's ticket list");
    expect(alt).toContain(
      "in the team's default order, open ones first and among them New tickets that say what would prove them fixed",
    );
    expect(read("src/server/tickets/repository.ts")).toContain(
      "(status = 'new' AND fix_check IS NOT NULL) DESC",
    );
  });
});

describe("what it is built with", () => {
  const start = readme.indexOf("## What it is built with");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  const rows = section.split("\n").filter((line) => line.startsWith("| "));

  it("is one table of three columns and at most ten rows, after the links", () => {
    expect(start).toBeGreaterThan(readme.indexOf("**The source:"));
    expect(start).toBeLessThan(readme.indexOf("## Run it yourself"));
    expect(rows[0]).toMatch(/^\| Layer +\| Choice +\| Why +\|$/);
    expect(rows.length - 2).toBeLessThanOrEqual(10);
    for (const row of rows) expect(row.split("|").length, row).toBe(5);
  });

  it("names only what the code uses", () => {
    expect(section).toContain("TypeScript, strict, on Node 22.14 or newer");
    expect(read("tsconfig.json")).toContain('"strict": true');
    expect(read("package.json")).toContain('"node": ">=22.14"');
    expect(section).toContain("Express 5");
    expect(packageJson.dependencies.express).toMatch(/^\^5\./);
    for (const name of ["ejs", "@picocss/pico", "better-sqlite3", "better-auth", "zod"]) {
      expect(packageJson.dependencies[name], name).toBeDefined();
    }
    expect(packageJson.dependencies["zod-openapi"]).toBeDefined();
    expect(packageJson.dependencies["@modelcontextprotocol/server"]).toBeDefined();
    const migrations = fs.readdirSync("migrations").filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(section).toContain(`${migrations.length} numbered SQL migrations`);
    expect(read("src/server/app.ts")).toContain('api.get("/openapi.json"');
    expect(read("src/server/app.ts")).toContain('app.all("/mcp"');
    for (const name of ["vitest", "supertest", "@playwright/test"]) {
      expect(packageJson.devDependencies[name], name).toBeDefined();
    }
    expect(read("Dockerfile")).toContain("FROM node:22");
    expect(read("fly.toml")).toContain("[[mounts]]");
    expect(read(".github/workflows/ci.yml")).toContain("docker build");
  });

  it("is said once: the prose line that listed the stack is gone", () => {
    expect(readme).not.toContain(
      "Express 5 and TypeScript (strict), SQLite with numbered migrations",
    );
  });

  it("links a diagram that GitHub draws, of three callers, one service and SQLite", () => {
    expect(section).toContain("(docs/ARCHITECTURE.md)");
    const notes = read("docs/ARCHITECTURE.md");
    const diagram = notes.slice(
      notes.indexOf("```mermaid"),
      notes.indexOf("```", notes.indexOf("```mermaid") + 3),
    );
    expect(notes.indexOf("```mermaid")).toBeLessThan(notes.indexOf("## Layers"));
    for (const words of [
      "A browser",
      "A program using the JSON API",
      "An AI assistant over MCP",
      "The ticket service",
      "The permission table, can()",
      "SQLite",
    ]) {
      expect(diagram, words).toContain(words);
    }
    expect([...diagram.matchAll(/\w+\[/g)].length).toBeLessThanOrEqual(12);
  });
});

describe("claims made exact", () => {
  it("say which commands take a version, and that a bulk change acts on each ticket as it is", () => {
    const limits = flat("README.md").slice(flat("README.md").indexOf("## Known limits"));
    expect(limits).toContain(
      "Replies, notes, evidence, specs, archive, restore and deletion take none, and a bulk change acts on each ticket as it is now.",
    );
    expect(read("src/server/tickets/bulk.ts")).toContain("A bulk change carries no versions");
    for (const file of ["conversation.ts", "evidence-and-specs.ts"]) {
      expect(read(`src/server/tickets/${file}`), file).not.toContain("requireVersion(");
    }
  });

  it("say a ticket's pictures are never cached either", () => {
    expect(flat("docs/SECURITY.md")).toContain(
      "Answers to signed-in people are never cached, a ticket's pictures included.",
    );
    expect(read("src/server/routes/pages.ts")).not.toContain("max-age=3600");
  });

  it("say what a keyed delete leaves, and that a bulk change's saved answer outlives the ticket", () => {
    const security = flat("docs/SECURITY.md");
    expect(security).toContain(
      "a delete sent with an idempotency key leaves that wipe to the next checkpoint",
    );
    expect(read("src/server/tickets/filing.ts")).toContain("db.inTransaction ? false");
    expect(security).toContain("belongs to no single ticket, so it keeps that change's words");
    expect(read("src/server/tickets/repository.ts")).toContain(
      "DELETE FROM idempotency_keys WHERE created_at < ?",
    );
  });

  it("no longer say two actions parse their input in the action table", () => {
    expect(flat("docs/ARCHITECTURE.md")).not.toContain("parse their input in that table");
    const actions = read("src/server/api/actions.ts");
    expect(actions).toContain("service.addNote(key, body, actor)");
    expect(actions).toContain("service.askOwnerToReview(key, body, actor)");
  });
});

describe("the design debt list", () => {
  const notes = flat("docs/ARCHITECTURE.md");

  it.each([
    "The staff list runs about two queries per row.",
    "Display limits are also membership checks.",
    "Hidden events can crowd the customer's history.",
    '"Review requested" can go stale.',
    "A confirmed proof can still be edited.",
    "No restore drill on the host.",
    "Nothing watches the two sites.",
    "is written by hand on purpose, as an answer key independent of the table it checks.",
  ])("says: %s", (line) => {
    expect(notes).toContain(line);
  });

  it("ties the 200-row limit to the checks that use it", () => {
    expect(read("src/server/tickets/types.ts")).toContain("THREAD_LIMIT = 200");
    expect(read("src/server/tickets/customer-question.ts")).toContain(
      "repository.listEvidence(db, before.id, THREAD_LIMIT)",
    );
  });
});

describe("the measured test numbers", () => {
  const tests = flat("README.md").slice(flat("README.md").indexOf("## Tests"));
  const notes = flat("docs/ARCHITECTURE.md");

  it("name the command, the four totals as whole percentages, and what the measure leaves out", () => {
    for (const text of [tests, notes]) {
      expect(text).toContain("`npm run test:coverage`");
      expect(text).toMatch(
        /\d{2}% of statements, \d{2}% of branches, \d{2}% of functions and \d{2}% of lines in `src`/,
      );
      expect(text).toContain("the Playwright tests, which this measure does not count");
      expect(text).toMatch(/over \d,\d00 /);
    }
    expect(read("package.json")).toContain('"test:coverage": "vitest run --coverage"');
  });

  it("never claim the code is fully tested", () => {
    for (const file of ["README.md", "docs/ARCHITECTURE.md"]) {
      expect(flat(file), file).not.toMatch(/fully tested|100 percent|100%/i);
    }
  });
});

import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The docs were brought up to the product of 19 November: a ticket shaped like a good prompt,
// the proof step after filing, the Proof column, marking fixed in one press and the customer's
// optional Yes. Each check ties a sentence in the docs to the file the product reads it from.

const read = (file: string) => fs.readFileSync(file, "utf8");
const flat = (file: string) => read(file).replace(/\s+/g, " ");
const readme = read("README.md");

/** Every view and the page routes, where the on-screen labels are written. */
const pageSource = [
  ...fs.readdirSync("views").map((name) => read(`views/${name}`)),
  read("src/server/routes/pages.ts"),
].join("\n");

const EIGHT_PRESSES = [
  "File a sample ticket",
  "File ticket",
  "Save",
  "View this ticket as a team member",
  "Take ticket and start work",
  "Mark fixed and tell the customer",
  "View this ticket as the customer who filed it",
  "Yes, it is fixed",
];

describe("the README's opening", () => {
  const paragraphs = readme.split("\n\n").map((p) => p.replace(/\s+/g, " ").trim());

  it("gives the reason for the product first: a ticket shaped like a good prompt", () => {
    expect(paragraphs[0]).toBe("# Proofdesk");
    const reason = paragraphs[1]!;
    expect(reason).toContain("the problem, the context and a way to check the result");
    expect(reason).toContain("a person or an assistant, can tell when it is done");
  });

  it("follows with the pitch line, word for word, and claims nothing it does not measure", () => {
    expect(paragraphs[2]).toBe(
      "Say what would prove it is fixed, and your ticket is listed first and checked against your own words.",
    );
    expect(readme).not.toMatch(/more accurate|faster|better results/i);
  });
});

describe("the README's walkthrough", () => {
  it("names the eight presses exactly as the views do, in order", () => {
    const start = readme.indexOf("## One ticket, start to finish");
    const walk = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const steps = walk
      .split("\n")
      .filter((line) => /^(\d+\.| {3})/.test(line))
      .join(" ");
    const statuses = new Set(["New", "In Progress", "Resolved"]);
    const pressed = [...steps.matchAll(/\*\*([^*]+)\*\*/g)]
      .map((m) => m[1]!)
      .filter((label) => !statuses.has(label));
    expect(pressed).toEqual(EIGHT_PRESSES);
    for (const label of EIGHT_PRESSES) {
      expect(pageSource.includes(`>${label}<`) || pageSource.includes(`"${label}"`), label).toBe(
        true,
      );
    }
  });
});

describe("the docs, against the pages of 19 November", () => {
  const visitorDocs = [
    "README.md",
    "docs/TOUR.md",
    "docs/AGENTS_GUIDE.md",
    "docs/API.md",
    "docs/DEPLOY.md",
    "docs/ARCHITECTURE.md",
  ];

  it("never name an on-screen label the product has retired", () => {
    const retired = [
      "Ask the customer to verify",
      "Yes, resolve ticket",
      "How will we know it's fixed?",
      '"How to verify"',
      "Waiting on",
      "Resolve with a reason",
      "Admin preview",
      "Initial status",
      "Everyone, Mine",
    ];
    for (const label of retired) expect(pageSource, label).not.toContain(label);
    for (const file of visitorDocs) {
      for (const label of retired) expect(flat(file), `${file}: ${label}`).not.toContain(label);
    }
  });

  it("name the proof's label, the Proof column and the step's buttons as the pages draw them", () => {
    expect(read("views/proof-step.ejs")).toContain("Skip for now");
    expect(pageSource).toContain("What would prove it is fixed?");
    expect(read("views/ticket-list.ejs")).toMatch(/>Proof</);
    const tour = flat("docs/TOUR.md");
    expect(tour).toContain('"What would prove it is fixed?", two grey lines, one box');
    expect(tour).toContain("A narrow **Proof** column after Status");
    expect(readme).toContain("Proof column");
  });

  it("say what the list shows by default, as the index orders it", () => {
    const index = read("migrations/0040_list_verifiable_first.sql");
    expect(index).toContain("(status = 'new' AND fix_check IS NOT NULL) DESC");
    const order = "New tickets that say what would prove them fixed come first, newest first";
    expect(flat("docs/TOUR.md")).toContain(order);
    expect(flat("docs/API.md")).toContain(
      "New tickets that say what would prove them fixed first, newest first",
    );
  });
});

describe("the production checklist's indexes", () => {
  it("names the list's default index, and only indexes the migrations leave in place", () => {
    const checklist = read("docs/PRODUCTION_CHECKLIST.md");
    expect(checklist).toContain("`tickets_list_verifiable_first`");
    const migrations = fs
      .readdirSync("migrations")
      .map((name) => read(`migrations/${name}`))
      .join("\n");
    const named = [
      ...checklist.matchAll(/`((?:tickets_list|idx|agent_activity)_[a-z_]+|ticket_search)`/g),
    ].map((m) => m[1]!);
    expect(named.length).toBeGreaterThan(5);
    for (const name of named) {
      const made = new RegExp(
        `CREATE (?:UNIQUE |VIRTUAL )?(?:INDEX|TABLE) (?:IF NOT EXISTS )?${name}\\b`,
      );
      expect(migrations, name).toMatch(made);
      expect(migrations, name).not.toMatch(new RegExp(`DROP INDEX ${name}\\b`));
    }
  });
});

describe("the roadmap's ideas", () => {
  it("lists the owner's ten ideas as ideas, one sentence each, before what was dropped", () => {
    const roadmap = read("docs/ROADMAP.md");
    const start = roadmap.indexOf("## Ideas, not promises");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(roadmap.indexOf("## Dropped"));
    const ideas = roadmap
      .slice(start, roadmap.indexOf("## Dropped"))
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(ideas).toHaveLength(10);
    for (const idea of ideas) expect(idea.match(/\. /g), idea).toBeNull();
  });
});

describe("the build log", () => {
  it("has a row for each pull request merged since the last docs pass, in merge order", () => {
    const log = read("docs/BUILD_LOG.md");
    const merged = [
      166, 167, 168, 169, 170, 171, 172, 173, 174, 175, 176, 177, 178, 179, 181, 180, 182, 183, 185,
      186, 187, 184, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198,
    ];
    const at = merged.map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

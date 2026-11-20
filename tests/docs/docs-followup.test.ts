import fs from "node:fs";
import { describe, expect, it } from "vitest";

// After the docs pass of 19 November, a finishing pass renamed several labels and changed the
// Proof marks, and three faults were fixed through the product itself. Each check ties a docs
// sentence to the view it describes, or to the record of that run.

const read = (file: string) => fs.readFileSync(file, "utf8");
const flat = (file: string) => read(file).replace(/\s+/g, " ");
const readme = read("README.md");
const tour = flat("docs/TOUR.md");

describe("the labels the finishing pass renamed", () => {
  it("are named in the tour exactly as the views draw them", () => {
    const show = read("views/ticket-show.ejs");
    expect(show).toContain('"Send to the team"');
    expect(show).toContain(">Emails sent about this ticket</a>");
    expect(read("views/ticket-list.ejs")).toContain(
      'placeholder="Search words or a key, then press Enter"',
    );
    expect(read("views/header.ejs")).toContain('class="outline new-ticket">New<span');

    expect(tour).toContain("the customer's button reads **Send to the team**");
    // Marking fixed is the team member's agreement that the customer's proof was met; the page
    // has no form for a person's evidence, so no guide sends a reader to one.
    expect(show).toContain("By marking it fixed, you agree this is met:");
    expect(show).not.toContain("Add evidence of the fix");
    expect(tour).toContain('`By marking it fixed, you agree this is met: "<their words>"`');
    for (const file of [
      "README.md",
      "docs/TOUR.md",
      "docs/AGENTS_GUIDE.md",
      "docs/ARCHITECTURE.md",
    ])
      expect(read(file), file).not.toContain("Add evidence of the fix");
    expect(tour).toContain("linked as **Emails sent about this ticket** under More options");
    expect(tour).toContain('in the box that reads "Search words or a key, then press Enter"');
    expect(tour).toContain("on a phone the header's button reads **New**");
    expect(readme).toContain(
      "a search box reading &quot;Search words or a key, then press Enter&quot;",
    );
  });
});

describe("the proof step's grey lines", () => {
  it("are two on the demo, the hint and the sample note, in the view, the README and the tour", () => {
    const step = read("views/proof-step.ejs");
    expect(step).toMatch(/id="proof-hint" class="hint"/);
    expect(step).toContain(
      "Sample suggestions. Press one or more to add them to the box. On a real site the team's own AI assistant",
    );
    expect(readme).toContain("&quot;What would prove it is fixed?&quot; two grey lines");
    expect(tour).toContain("two grey lines");
    expect(tour).toContain(
      '"Sample suggestions. Press one or more to add them to the box. On a real site the team\'s own AI assistant writes these. Edit or remove added text in the box."',
    );
    for (const text of [readme, tour]) expect(text).not.toContain("one grey line,");
  });
});

describe("the list picture and the Proof marks", () => {
  it("describe both marks and the sample with no proof", () => {
    const seed = read("src/server/demo.ts");
    expect(seed).toContain("Invoice shows the wrong date");
    const alt = /<img src="docs\/img\/ticket-list.png"[^>]*alt="([^"]+)"/.exec(readme)![1]!;
    expect(alt).toContain("a pale check marks a ticket that says what would prove it fixed");
    expect(alt).toContain("a solid green check marks one its customer confirmed");
    expect(alt).toContain("one New ticket has neither");
    expect(tour).toContain("a ticket with neither has no mark");
  });
});

describe("the dogfooding record", () => {
  const folder = "docs/dogfood-run";
  const files = [
    "summary.md",
    "transcript.public.jsonl",
    "listener.transcript.public.jsonl",
    "fixer-run-1.transcript.public.jsonl",
  ];

  it("is in the repository, every file the summary names, and the README links it", () => {
    const summary = read(`${folder}/summary.md`);
    for (const file of files.slice(1)) {
      expect(fs.existsSync(`${folder}/${file}`), file).toBe(true);
      expect(summary, file).toContain(file);
    }
    expect(readme).toContain("(docs/dogfood-run/summary.md)");
  });

  it("holds no local path, email address or key, and the summary reads as a record", () => {
    for (const file of files) {
      const text = read(`${folder}/${file}`);
      expect(text, file).not.toMatch(/\/Users\/|-Users-|\/home\/[a-z]/);
      expect(text, file).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
      expect(text, file).not.toMatch(/pd_[0-9a-f]{8}_[A-Za-z0-9]{20,}/);
      expect(text, file).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/);
    }
    const summary = read(`${folder}/summary.md`);
    expect(summary).not.toMatch(/\b(I|my|My|me)\b/);
    expect(summary).toContain("## Not done / what went wrong");
    expect(summary).toContain("**Fixer run 1 failed because of the settings");
  });

  it("is told in the README without claiming more than the record", () => {
    const start = readme.indexOf("## The AI assistant");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1)).replace(/\s+/g, " ");
    expect(section).toContain("were filed as tickets in a local Proofdesk");
    expect(section).toContain("within about five seconds");
    expect(section).toContain('before pressing "Mark fixed and tell the customer"');
    expect(section).toContain("blocked by the operator's own permission settings");
    expect(section).toContain("run once more with the same prompt");
    const summary = flat(`${folder}/summary.md`);
    expect(summary).toContain("within 4 to 5 seconds");
    expect(summary).toContain("ran it once more with the same prompt");
  });

  it("says an AI agent did the operator's steps, with no human in the loop", () => {
    const start = readme.indexOf("## The AI assistant");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1)).replace(/\s+/g, " ");
    expect(section).toContain("A second AI agent, as the team member and the customer");
    expect(section).toContain("No human was in the loop.");
    expect(section).not.toMatch(/a person checked|checked by a person/i);

    const summary = flat(`${folder}/summary.md`);
    expect(summary).toContain("was done by a separate AI agent standing in for the people");
    expect(summary).toContain("No human was in the loop during the run");
    expect(summary).toContain("given by an AI agent in the team member's seat");
    expect(summary).toContain("## Operator steps");
    expect(summary).toContain("## Operator's check");
    expect(summary).not.toMatch(/Human steps|Person-side|the person\b|a person checked/i);
  });

  it("leaves no other doc saying a person checked the dogfooded fixes", () => {
    const docs = ["README.md", ...fs.readdirSync("docs").filter((f) => f.endsWith(".md"))];
    for (const name of docs) {
      const text = flat(name === "README.md" ? name : `docs/${name}`);
      expect(text, name).not.toMatch(/checked by a person|a person checked/i);
    }
  });
});

describe("the build log", () => {
  it("has a row for each pull request merged after the last docs pass, in merge order", () => {
    const log = read("docs/BUILD_LOG.md");
    const at = [199, 201, 200].map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

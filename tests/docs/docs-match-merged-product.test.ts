import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The words in the README and the docs must be the words the product shows after the last
// changes, of 18 November and then of 19 November. Each check ties a quote in the docs to the
// file the product reads it from, so a quote cannot fall behind the page again.

const flat = (file: string) => fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
const readme = flat("README.md");
const tour = flat("docs/TOUR.md");

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(" ## ", start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

describe("quotes of the ticket page", () => {
  it("name the Status menu's resolve form as the page does", () => {
    const page = flat("views/ticket-show.ejs");
    expect(page).toContain('?step=resolve#resolve-form">');
    expect(page).toContain("Why are you resolving this ticket?");
    expect(tour).toContain('"Why are you resolving this ticket?" with five reasons');
    for (const text of [readme, tour]) {
      expect(text).not.toContain("Resolve with a reason");
      expect(text).not.toContain('press "Resolved" under Status');
    }
  });

  it("describe Status and Owner as two menus under the title, not a row of buttons", () => {
    for (const text of [readme, tour]) {
      expect(text).not.toMatch(/status row/i);
      expect(text).not.toContain("side panel");
    }
    expect(readme).toContain("The team's Status menu, under the title");
    expect(tour).toContain("Status and Owner are two small menus under the title");
  });

  it("quote the filing receipt with its key and what happens next", () => {
    expect(fs.readFileSync("src/server/pages/saved.ts", "utf8")).toContain(
      '"The support team has it now; come back to this page for updates."',
    );
    const receipt = "Ticket SUP-n filed. The support team has it now; come back to this page";
    expect(tour).toContain(receipt);
  });

  it("give the resolve form's Fixed reason, and no Waiting on column", () => {
    expect(fs.readFileSync("src/server/routes/pages.ts", "utf8")).toContain(
      '"Fixed (the customer is told)"',
    );
    expect(tour).toContain('"Fixed (the customer is told)"');
    expect(tour).not.toContain("Waiting on");
  });

  it("say a stale edit names the other person's change, and the notice says what changed", () => {
    expect(fs.readFileSync("views/ticket-form.ejs", "utf8")).toContain("They changed:");
    expect(fs.readFileSync("src/browser/ticket-changed.ts", "utf8")).toContain(
      "`This ticket is now ${status}.`",
    );
    expect(tour).toContain('`They changed: Title, now "..."`');
    expect(tour).toContain('"This ticket is now In Progress. Refresh to see it."');
    expect(fs.readFileSync("src/browser/ticket-changed.ts", "utf8")).toContain(
      '"This ticket has a new message."',
    );
    expect(tour).toContain('"This ticket has a new message. Refresh to see it."');
    expect(tour).not.toContain("naming what is different on the ticket now");
  });
});

describe("the demo, as the README describes it", () => {
  it("resets when it has been quiet, as its About page says, not once a day", () => {
    expect(fs.readFileSync("views/sign-in.ejs", "utf8")).toContain(
      "The demo resets itself when it has been quiet for a while.",
    );
    expect(readme).toContain("by itself when it has been quiet for a while");
    expect(readme).not.toMatch(/once a day|one-day key/);
    expect(flat("docs/AGENTS_GUIDE.md")).toContain("for a day at most");
  });

  it("captions the ticket list without the Archived tab the demo no longer shows", () => {
    const tag = /<img src="docs\/img\/ticket-list.png"[^>]*>/.exec(readme)![0];
    expect(tag).not.toContain("Archived");
    expect(tag).toContain("All, New, In Progress and Resolved");
  });

  it("states the recorded run's scope the way the assistant page does", () => {
    expect(flat("views/assistant-run.ejs")).toContain(
      "in a scratch file, from the ticket's text, because it had no access to the product's code",
    );
    const assistant = section(readme, "## The AI assistant");
    expect(assistant).toContain("because it had no access to the product's code");
    expect(assistant).not.toContain("reproduced the customer's problem");
  });
});

describe("the README's known limits", () => {
  it("say what happens to tickets when someone leaves the team", () => {
    expect(fs.readFileSync("src/server/people/service.ts", "utf8")).toContain(
      "Hand ${them} to someone else first.",
    );
    const limits = section(readme, "## Known limits");
    expect(limits).toContain("will not make someone a customer while they own open tickets");
    expect(limits).toContain("goes back to New with no owner");
    expect(limits).not.toContain("reassigning tickets when someone leaves the team");
  });
});

describe("the specification", () => {
  const spec = flat("docs/SPEC.md");

  it("sends readers to where the limits live now, not to the README", () => {
    expect(spec).not.toContain("listed in the README's limits");
    expect(spec).toContain("anything already sent elsewhere, and `docs/SECURITY.md` says so");
    expect(flat("docs/SECURITY.md")).toContain("Permanent deletion does not reach backups");
    expect(spec).toContain("what comes next is in `docs/ROADMAP.md`");
  });

  it("records the late evening's changes", () => {
    expect(spec).toContain("### 2026-11-18, late evening: words a reader can act on");
  });
});

describe("the roadmap", () => {
  const roadmap = fs.readFileSync("docs/ROADMAP.md", "utf8");
  const planned = roadmap.slice(roadmap.indexOf("## After sending"), roadmap.indexOf("## Dropped"));
  const built = roadmap.slice(roadmap.indexOf("## Already built"));

  it("plans the two filters readers asked for", () => {
    expect(planned).toContain('"longest waiting" order');
    expect(planned).toContain("A filter by a named owner");
  });

  it("credits those two filters to testers walking the demo, not to people in general", () => {
    expect(planned).not.toContain("Asked for by people trying the demo.");
    expect(planned.match(/Asked for by testers walking the demo\./g)).toHaveLength(2);
  });

  it("plans nothing that has shipped, and lists it as built", () => {
    expect(planned).not.toMatch(/^\| \d+ +\| Search +\|/m);
    expect(planned).not.toMatch(/email notices|People page|old copy/i);
    for (const shipped of ["**Search**", "**Email notices**", "**The People page**"]) {
      expect(built).toContain(shipped);
    }
    expect(built).toContain("**Two people on one ticket:**");
  });
});

describe("the build log", () => {
  it("has a row for each pull request merged late on 18 November, in merge order", () => {
    const log = fs.readFileSync("docs/BUILD_LOG.md", "utf8");
    const merged = [157, 156, 158, 160, 159, 161];
    const at = merged.map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

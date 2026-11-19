import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTIONS } from "../../src/server/api/actions.js";
import { LIST_ORDERS } from "../../src/server/tickets/schemas.js";

// The docs must say what the product does after the status row, the version check and the list
// changes. Each check ties a sentence in the docs to the code or page that makes it true.

const flat = (file: string) => fs.readFileSync(file, "utf8").replace(/\s+/g, " ");

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + heading.length);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The lines of one feature in the tour's "Try each feature in a minute", by its bold heading. */
function feature(heading: string): string {
  const tour = fs.readFileSync("docs/TOUR.md", "utf8");
  const features = section(tour, "## Try each feature in a minute");
  const start = features.indexOf(`**${heading}**`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = features.indexOf("\n**", start + heading.length + 4);
  return features.slice(start, end === -1 ? undefined : end);
}

async function demoApp() {
  const { DEV_COOKIE } = await import("../../src/server/actor.js");
  const { seedDemo } = await import("../../src/server/demo.js");
  const { createTicketService } = await import("../../src/server/tickets/service.js");
  const { buildTestApp, visitor } = await import("../helpers.js");
  const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(demo.db, demo.config.ticketPrefix);
  seedDemo(service);
  const as = (id: string) => visitor(demo.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  return { demo, service, as, visitor: () => visitor(demo.app) };
}

describe("the tour's steps for changing a status", () => {
  it("start from the ticket the visitor filed, since a sample may belong to another customer", async () => {
    for (const heading of ["Update status: New to In Progress", "Update status: to Resolved"]) {
      expect(feature(heading)).toMatch(/^- Start as: .*the ticket you (just )?filed/im);
    }
    // Why: a sample filed by a customer the visitor cannot be offers no switch to that customer.
    const { as, demo } = await demoApp();
    const keys = (
      demo.db.prepare("SELECT id FROM tickets WHERE status = 'new'").all() as { id: number }[]
    ).map((row) => `${demo.config.ticketPrefix}-${row.id}`);
    expect(keys.length).toBeGreaterThan(0);
    const offers = [];
    for (const key of keys) {
      const page = await as("demo-team").get(`/tickets/${key}`);
      offers.push(page.text.includes("View this ticket as the customer who filed it"));
    }
    expect(offers).toContain(false);
  });

  it("open the assistant section on the welcome page before its demo connection", async () => {
    const press = /^- Press: (.*)$/m.exec(feature("AI features"))![1]!;
    const open = press.indexOf("**Connect your own AI assistant**");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(press.indexOf("**Get a demo connection**")).toBeGreaterThan(open);

    const { visitor } = await demoApp();
    const welcome = (await visitor().get("/sign-in")).text;
    const folded = /<summary>Connect your own AI assistant<\/summary>([\s\S]*?)<\/details>/.exec(
      welcome,
    );
    expect(folded).not.toBeNull();
    expect(folded![1]).toContain("Get a demo connection");
  });
});

describe("what is new, as the tour says it", () => {
  it("names the list's counts and key search with the page's own words", () => {
    expect(feature("Ticket list with filters")).toContain("A typed key opens that ticket");
    expect(feature("Ticket list with filters")).toContain("count beside each status");
  });

  it("says a save from an old copy is refused, and quotes the open page's notice", () => {
    const script = fs.readFileSync("src/browser/ticket-changed.ts", "utf8");
    // The notice names the change when it can ("This ticket is now Resolved."); these are its
    // plain words when it cannot, followed by the Refresh link.
    expect(script).toContain('return "This ticket changed.";');
    expect(script).toContain('refresh, " to see it."');
    const steps = feature("Two people on one ticket").replace(/\s+/g, " ");
    expect(steps).toContain("This ticket changed. Refresh to see it.");
    expect(steps).toContain("refused and keeps what you typed");
  });

  it("no longer lists last writer wins as a limit", () => {
    const limits = section(fs.readFileSync("README.md", "utf8"), "## Known limits");
    expect(limits).not.toMatch(/last writer wins/i);
    expect(limits).toContain("`expected_version`");
  });

  it("captions the customer's card as it looks after one press of asking", async () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const tag = /<img src="docs\/img\/did-this-fix-it.png"[^>]*>/.exec(readme)![0];
    expect(tag).not.toContain("optional details");
    const { as } = await demoApp();
    const filed = await as("demo-customer")
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "x", fix_check: "Every row" });
    const key = filed.body.key as string;
    await as("demo-team").post(`/api/tickets/${key}/take-and-start`);
    await as("demo-team").post(`/api/tickets/${key}/ready`).send({});
    const page = (await as("demo-customer").get(`/tickets/${key}`)).text;
    expect(page).toContain("Did this fix it?");
    expect(page).toContain("Every row");
    expect(page).not.toContain("tried:");
  });
});

describe("the API reference", () => {
  const api = fs.readFileSync("docs/API.md", "utf8");

  it("lists exactly the routes that accept expected_version", () => {
    const takesVersion = ACTIONS.filter(
      (action) => action.body instanceof z.ZodObject && "expected_version" in action.body.shape,
    ).map((action) => `${action.method.toUpperCase()} /api${action.path}`);
    const part = section(api, "## Two people on one ticket");
    const listed = [...part.matchAll(/`((?:GET|POST|PUT|PATCH|DELETE) \/api[^`]*)`/g)].map(
      (m) => m[1],
    );
    expect(listed.sort()).toEqual(takesVersion.sort());
    expect(part).toContain("409 `ticket_changed`");
    expect(part).toContain("skips the check");
  });

  it("names every list order and the return to New", () => {
    const row = (route: string) =>
      api.split("\n").find((line) => line.startsWith(`| \`${route}\``))!;
    for (const order of LIST_ORDERS) expect(row("GET /api/tickets")).toContain(`\`${order}\``);
    expect(row("GET /api/tickets/:key")).toContain("`version`");
    expect(row("PATCH /api/tickets/:key")).toContain('"new"');
  });
});

describe("the production checklist", () => {
  const checklist = fs.readFileSync("docs/PRODUCTION_CHECKLIST.md", "utf8");

  it("gives the measured numbers and says which findings were fixed and which remain", () => {
    expect(checklist).not.toMatch(/to come/i);
    const load = section(checklist, "## Load test");
    expect(load).toContain("indicative only");
    expect(load).toContain("before the list index");
    expect(load).toContain("Fixed since:");
    expect(load).toContain("Still open:");
  });

  it("marks two people at once as met by the version check", () => {
    const row = checklist.split("\n").find((line) => line.startsWith("| Two people at once"))!;
    expect(row).not.toContain("the last save wins");
    expect(row).toMatch(/\| Met +\|/);
    expect(fs.existsSync("tests/two-people-one-ticket.test.ts")).toBe(true);
  });
});

describe("the specification", () => {
  const spec = flat("docs/SPEC.md");

  it("no longer leaves out text search, and records the evening's changes", () => {
    const leftOut = section(fs.readFileSync("docs/SPEC.md", "utf8"), "## Left out on purpose");
    const list = leftOut.split("(")[0]!;
    expect(list).not.toContain("text search");
    expect(spec).toContain("### 2026-11-18, evening: the status row, two people on one ticket");
    expect(spec).toContain("nothing is required before asking again");
  });
});

describe("the assistants' guide", () => {
  it("names the sample made for assistants by the key the demo gives it", async () => {
    const { service } = await demoApp();
    const key = service.assistantSampleKey()!;
    const guide = fs.readFileSync("docs/AGENTS_GUIDE.md", "utf8");
    expect(guide).toContain(`(\`${key}\` on a new demo)`);
    expect(guide).toContain(`write a test spec for ${key}\``);
    const keys = new Set([...guide.matchAll(/"key": "([A-Z]+-\d+)"/g)].map((m) => m[1]));
    expect([...keys]).toEqual([key]);
  });
});

describe("the build log", () => {
  it("has a row for each pull request merged on the evening of 18 November, in merge order", () => {
    const log = fs.readFileSync("docs/BUILD_LOG.md", "utf8");
    const merged = [143, 144, 140, 145, 146, 147, 148, 150, 151, 149, 152, 153, 154, 155];
    const at = merged.map((pr) => {
      const match = new RegExp(`\\| #${pr} +\\|`).exec(log);
      expect(match, `#${pr}`).not.toBeNull();
      return match!.index;
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });
});

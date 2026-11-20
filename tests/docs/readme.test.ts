import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../../src/server/api/actions.js";

// The API reference's list of routes must be the routes there are: none missing, none invented.

// A command a reader copies has to be readable on a phone, so a long one is split across lines.
describe("the commands in the README, the assistants' guide and the API reference", () => {
  it("are at most 56 characters a line", () => {
    for (const file of ["README.md", "docs/AGENTS_GUIDE.md", "docs/API.md"]) {
      const text = fs.readFileSync(file, "utf8");
      const blocks = [...text.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]!);
      expect(blocks.length).toBeGreaterThan(0);
      const long = blocks.flatMap((b) => b.split("\n")).filter((line) => line.length > 56);
      expect(long, file).toEqual([]);
    }
  });
});

describe("the API reference's route table", () => {
  it("lists every route in the action table, and no route that is not there", () => {
    const table = fs.readFileSync("docs/API.md", "utf8");
    const listed = [...table.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`]+)`/gm)]
      .map((m) => `${m[1]} ${m[2]}`)
      .filter((route) => route !== "GET /api/health")
      .sort();
    const routes = ACTIONS.map((row) => `${row.method.toUpperCase()} /api${row.path}`).sort();
    expect(listed).toEqual(routes);
  });
});

// The tour's feature list and the README's one walkthrough name the exact buttons, links and
// filters a visitor presses. Each one must be on a page the demo actually shows, so neither can
// promise a label the product does not have.
describe("the feature list and the README's walkthrough", () => {
  // Both are written for someone trying the product.
  it("are headed for a visitor trying the product", () => {
    const tour = fs.readFileSync("docs/TOUR.md", "utf8");
    const readme = fs.readFileSync("README.md", "utf8");
    const headings = [...(tour + readme).matchAll(/^(#{1,6} .+|\*\*[^*]+\*\*)$/gm)].map(
      (m) => m[1]!,
    );
    expect(headings).toContain("## Try each feature in a minute");
    expect(headings).toContain("## One ticket, start to finish");
  });

  it("name only labels the demo shows", async () => {
    const { parse } = await import("node-html-parser");
    const { DEV_COOKIE } = await import("../../src/server/actor.js");
    const { seedDemo } = await import("../../src/server/demo.js");
    const { createTicketService } = await import("../../src/server/tickets/service.js");
    const { buildTestApp, SIGN_IN_ENV, visitor } = await import("../helpers.js");

    const tour = fs.readFileSync("docs/TOUR.md", "utf8");
    const start = tour.indexOf("## Try each feature in a minute");
    const table = tour.slice(start);
    // Each feature lists where to start and what to press; the bold words there are labels.
    const labels = new Set<string>();
    for (const line of table.split("\n")) {
      if (!/^- (Start as|Press):/.test(line)) continue;
      for (const m of line.matchAll(/\*\*([^*]+)\*\*/g)) labels.add(m[1]!);
    }
    expect(table).not.toMatch(/^\|/m);
    expect(labels.size).toBeGreaterThan(10);
    // The README's walkthrough: every bold word in its numbered steps is a label or a status.
    const readme = fs.readFileSync("README.md", "utf8");
    const walkStart = readme.indexOf("## One ticket, start to finish");
    const walk = readme.slice(walkStart, readme.indexOf("\n## ", walkStart + 1));
    const walkLabels = [...walk.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
    expect(walkLabels.length).toBeGreaterThan(6);
    for (const label of walkLabels) labels.add(label);
    // The tour quotes the line above "Mark fixed and tell the customer" that says marking it
    // fixed agrees the customer's proof was met; the team's page after taking shows it.
    const oath = "By marking it fixed, you agree this is met:";
    expect(tour.replace(/\s+/g, " ")).toContain(`\`${oath} "<their words>"\``);

    // The pages a visitor passes through on the demo, and the real site's sign-in.
    const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(demo.db, demo.config.ticketPrefix);
    seedDemo(service);
    const as = (id: string) => visitor(demo.app).set("Cookie", `${DEV_COOKIE}=${id}`);
    const filed = await as("demo-customer")
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "x", fix_check: "Every row" });
    const key = filed.body.key as string;
    // A ticket filed with no proof opens on the second step, which a ticket with one reopens.
    const bare = await as("demo-customer")
      .post("/api/tickets")
      .send({ title: "Printing is slow", description: "x" });
    const team = (path: string) => as("demo-team").post(`/api/tickets/${key}${path}`);
    const pages = [
      await as("demo-customer").get(`/tickets/${bare.body.key as string}?step=verify`),
      await as("demo-customer").get(`/tickets/${key}?step=verify`),
      await visitor(demo.app).get("/sign-in"),
      await as("demo-customer").get("/tickets"),
      await as("demo-customer").get("/tickets/new?try=1").redirects(1),
      await as("demo-customer").get(`/tickets/${key}`),
      await as("demo-team").get("/tickets"),
      await as("demo-team").get(`/tickets/${key}`),
      // Who may do what, and the demo admin's People page with its Check this change.
      await as("demo-team").get("/roles"),
      await as("demo-admin").get("/people"),
    ];
    await team("/take-and-start");
    pages.push(await as("demo-team").get(`/tickets/${key}`));
    await as("demo-team")
      .put(`/api/tickets/${key}/change-link`)
      .send({ change_url: "https://example.com/c" });
    pages.push(await as("demo-team").get(`/tickets/${key}`));
    await team("/ready").send({
      try_url: "https://example.com/t",
      tried: "Ran it.",
      result: "Ok.",
    });
    pages.push(await as("demo-team").get(`/tickets/${key}`));
    pages.push(await as("demo-customer").get(`/tickets/${key}`));
    pages.push(await visitor(buildTestApp(SIGN_IN_ENV).app).get("/sign-in"));

    const shown = pages
      .map((res) => parse(res.text).querySelector("body")!.text.replace(/\s+/g, " "))
      .join(" ");
    for (const label of labels) expect(shown, label).toContain(label);
    expect(shown).toContain(oath);
  });
});

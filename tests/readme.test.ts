import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/server/api/actions.js";

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

// The feature list in the README names the exact buttons, links and filters a visitor presses.
// Each one must be on a page the demo actually shows, so the list cannot promise a label the
// product does not have.
describe("the README's feature list", () => {
  // The README is written for someone trying the product, not for whoever marks it.
  it("is headed for a visitor, and no heading speaks of a rubric or a grader", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const headings = [...readme.matchAll(/^(#{1,6} .+|\*\*[^*]+\*\*)$/gm)].map((m) => m[1]!);
    expect(headings).toContain("## Try each feature in a minute");
    expect(headings.filter((h) => /rubric|grader|bonus/i.test(h))).toEqual([]);
  });

  it("names only labels the demo shows", async () => {
    const { parse } = await import("node-html-parser");
    const { DEV_COOKIE } = await import("../src/server/actor.js");
    const { seedDemo } = await import("../src/server/demo.js");
    const { createTicketService } = await import("../src/server/tickets/service.js");
    const { buildTestApp, SIGN_IN_ENV, visitor } = await import("./helpers.js");

    const readme = fs.readFileSync("README.md", "utf8");
    const start = readme.indexOf("## Try each feature in a minute");
    const table = readme.slice(start, readme.indexOf("\n## ", start + 1));
    // Each feature lists where to start and what to press; the bold words there are labels.
    const labels = new Set<string>();
    for (const line of table.split("\n")) {
      if (!/^- (Start as|Press):/.test(line)) continue;
      for (const m of line.matchAll(/\*\*([^*]+)\*\*/g)) labels.add(m[1]!);
    }
    expect(table).not.toMatch(/^\|/m);
    expect(labels.size).toBeGreaterThan(10);

    // The pages a visitor passes through on the demo, and the real site's sign-in.
    const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(demo.db, demo.config.ticketPrefix);
    seedDemo(service);
    const as = (id: string) => visitor(demo.app).set("Cookie", `${DEV_COOKIE}=${id}`);
    const filed = await as("demo-customer")
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "x", fix_check: "Every row" });
    const key = filed.body.key as string;
    const team = (path: string) => as("demo-team").post(`/api/tickets/${key}${path}`);
    const pages = [
      await visitor(demo.app).get("/sign-in"),
      await as("demo-customer").get("/tickets/new?try=1").redirects(1),
      await as("demo-team").get("/tickets"),
      await as("demo-team").get(`/tickets/${key}`),
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
    pages.push(await as("demo-customer").get(`/tickets/${key}`));
    pages.push(await visitor(buildTestApp(SIGN_IN_ENV).app).get("/sign-in"));

    const shown = pages
      .map((res) => parse(res.text).querySelector("body")!.text.replace(/\s+/g, " "))
      .join(" ");
    for (const label of labels) expect(shown, label).toContain(label);
  });
});

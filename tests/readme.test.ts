import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/server/api/actions.js";

// The README's list of API routes must be the routes there are: none missing, none invented.

describe("the README's API table", () => {
  it("lists every route in the action table, and no route that is not there", () => {
    const readme = fs.readFileSync("README.md", "utf8");
    const table = readme.slice(readme.indexOf("### JSON API"), readme.indexOf("### Security"));
    const listed = [...table.matchAll(/^\| `(GET|POST|PUT|PATCH|DELETE) (\/api\/[^`]+)`/gm)]
      .map((m) => `${m[1]} ${m[2]}`)
      .filter((route) => route !== "GET /api/health")
      .sort();
    const routes = ACTIONS.map((row) => `${row.method.toUpperCase()} /api${row.path}`).sort();
    expect(listed).toEqual(routes);
  });
});

// The rubric table on the README's first screen names the exact buttons, links and filters a
// grader presses. Each one must be on a page the demo actually shows, so the table cannot
// promise a label the product does not have.
describe("the README's rubric table", () => {
  it("names only labels the demo shows", async () => {
    const { parse } = await import("node-html-parser");
    const { DEV_COOKIE } = await import("../src/server/actor.js");
    const { seedDemo } = await import("../src/server/demo.js");
    const { createTicketService } = await import("../src/server/tickets/service.js");
    const { buildTestApp, SIGN_IN_ENV, visitor } = await import("./helpers.js");

    const readme = fs.readFileSync("README.md", "utf8");
    const table = readme.slice(readme.indexOf("## The rubric"), readme.indexOf("## Who can do"));
    const rows = table.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---"));
    const labels = new Set<string>();
    for (const row of rows.slice(1)) {
      // A row starts with a pipe, so the cells are: "", rubric line, start as, press, result.
      const cells = row.split("|").map((cell) => cell.trim());
      const [startAs = "", press = ""] = [cells[2], cells[3]];
      for (const cell of [startAs, press]) {
        for (const m of cell.matchAll(/\*\*([^*]+)\*\*/g)) labels.add(m[1]!);
      }
    }
    expect(labels.size).toBeGreaterThan(10);

    // The pages a grader passes through on the demo, and the real site's sign-in.
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
      await as("demo-customer").get("/tickets/new?try=1"),
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

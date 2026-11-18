import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { reportFields } from "../src/server/pages/format.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Evidence reads one field per labelled line, and a report in a format Proofdesk does not read
// shows its top-level fields as sent, for the team.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

async function withEvidence(evidence: object) {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await admin(app).post("/api/tickets/SUP-1/evidence").send(evidence);
  return app;
}

describe("an evidence item", () => {
  it("puts each field on its own labelled line", async () => {
    const app = await withEvidence({
      kind: "test",
      summary: "Printed ten pages",
      link: "https://example.com/run/1",
      revision: "abc123",
      command: "npm test",
      result: "12 passed",
    });
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const fields = html.querySelector("ul.evidence dl.evidence-fields")!;
    expect(fields.querySelectorAll("dt").map((dt) => dt.text)).toEqual([
      "Link",
      "Revision",
      "Command",
      "Result",
    ]);
    expect(fields.querySelectorAll("dd").map((dd) => dd.text)).toEqual([
      "https://example.com/run/1",
      "abc123",
      "npm test",
      "12 passed",
    ]);
  });

  it("shows a plain report's top-level fields to the team, and nothing of it to the customer", async () => {
    const app = await withEvidence({
      kind: "test",
      summary: "Ran the tests",
      report: { runner: "node --test", passed: 3, failed: 0, details: { long: "x" } },
    });
    const team = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const report = team.querySelector("dl.report-fields")!;
    expect(report.querySelectorAll("dt").map((dt) => dt.text)).toEqual([
      "runner",
      "passed",
      "failed",
    ]);
    expect(report.querySelectorAll("dd").map((dd) => dd.text)).toEqual(["node --test", "3", "0"]);
    expect(team.querySelector("ul.evidence")!.text).toContain("1 more field not shown.");
    const customer = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    expect(customer).not.toContain("node --test");
  });
});

describe("reading a report's fields", () => {
  it("keeps plain values, at most twelve, each cut to 200 characters", () => {
    const report = Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [`field${i}`, "y".repeat(300)]),
    );
    const read = reportFields(report);
    expect(read.fields).toHaveLength(12);
    expect(read.fields[0]!.value).toHaveLength(200);
    expect(read.more).toBe(3);
    expect(reportFields([1, 2])).toEqual({ fields: [], more: 0 });
    expect(reportFields("text")).toEqual({ fields: [], more: 0 });
  });
});

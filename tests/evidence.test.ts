import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { readProveReport } from "../src/server/tickets/evidence.js";
import { DEMO_BUDGET } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  handToAgent,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

// Evidence beside the customer's check: stored as reported, read honestly, never a verdict.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

// An ops/prove report in its real shape: the new test failed before the fix, with an
// assertion; the existing tests passed before; everything passed after.
const proveReport = {
  ok: true,
  baseCommit: "a1b2c3d",
  patchSha256: "f".repeat(64),
  testPath: "tests/print.test.ts",
  baseline: { status: "held", reason: "suite passed", commands: ["npx vitest run"] },
  red: {
    status: "held",
    reason: "new test failed",
    failureMessage: "expected 1 to be 2",
    commands: ["npx vitest run tests/print.test.ts"],
  },
  green: { status: "held", reason: "all passed", commands: ["npx vitest run"] },
};

async function issue(app: Express, scopes: string[]) {
  const res = await admin(app).post("/connections").type("form").send({ name: "Helper", scopes });
  const key = keyOnPage(res.text);
  // The owner hands SUP-1 to this connection, when there is one: agents see only those.
  if ((await admin(app).get("/api/tickets/SUP-1")).status === 200) {
    await handToAgent(app, "SUP-1", key);
  }
  return key;
}

const attach = (app: Express, key: string, body: object) =>
  request(app).post("/api/tickets/SUP-1/evidence").set("Authorization", `Bearer ${key}`).send(body);

describe("attaching evidence", () => {
  it("stores the report exactly as sent and reads its stages", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "attach_evidence"]);
    const res = await attach(app, key, {
      kind: "test",
      summary: "A test reproduces the jam and passes after the fix",
      link: "https://example.com/pr/7",
      revision: "a1b2c3d",
      command: "npx vitest run tests/print.test.ts",
      result: "passed",
      report: proveReport,
    });
    expect(res.status, res.text).toBe(201);
    const [saved] = (await admin(app).get("/api/tickets/SUP-1/evidence")).body;
    expect(saved.report).toEqual(proveReport);
    expect(saved).toMatchObject({
      stages: { before_fix: "failed", existing_tests: "passed", after_fix: "passed" },
      reported_by: { kind: "agent", name: "Helper" },
      verified_by_proofdesk: false,
    });
  });

  it("never resolves the ticket or changes whom it waits on", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "attach_evidence"]);
    await attach(app, key, {
      kind: "test",
      summary: "All green",
      result: "passed",
      report: proveReport,
    });
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    // Still in progress, still with the team: evidence resolves nothing.
    expect(ticket).toMatchObject({ status: "in_progress", waiting_on: "team", ready_at: null });
  });

  it("is refused without the scope, to the customer, and on an archived ticket", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "write_notes"]);
    expect((await attach(app, key, { kind: "note", summary: "x" })).status).toBe(403);
    const customer = await as(app, customerOne)
      .post("/api/tickets/SUP-1/evidence")
      .send({ kind: "note", summary: "x" });
    expect(customer.status).toBe(403);
    await admin(app).post("/api/tickets/SUP-1/archive");
    const team = await as(app, teamActor)
      .post("/api/tickets/SUP-1/evidence")
      .send({ kind: "note", summary: "x" });
    expect(team.status).toBe(409);
  });

  it("refuses a link that is not http or https, and a report that is too large", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const bad = await admin(app)
      .post("/api/tickets/SUP-1/evidence")
      .send({ kind: "note", summary: "x", link: "javascript:alert(1)" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.link).toBeDefined();
    const big = await admin(app)
      .post("/api/tickets/SUP-1/evidence")
      .send({ kind: "test", summary: "x", report: { blob: "x".repeat(20001) } });
    expect(big.status).toBe(400);
  });

  it("stops at the demo's budget", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP", DEMO_BUDGET);
    service.createTicket(valid, teamActor);
    for (let i = 0; i < DEMO_BUDGET.evidencePerTicket!; i++) {
      service.addEvidence("SUP-1", { kind: "note", summary: `n${i}` }, teamActor);
    }
    expect(() =>
      service.addEvidence("SUP-1", { kind: "note", summary: "one more" }, teamActor),
    ).toThrow(/evidence/);
  });
});

describe("reading a test report honestly", () => {
  it("says failed before the fix only when the new test failed with an assertion", () => {
    const noMessage = { ...proveReport, red: { status: "held", reason: "?", commands: [] } };
    expect(readProveReport(noMessage)?.before_fix).toBe("unknown");
    const didNotFail = {
      ...proveReport,
      red: { status: "failed", reason: "passed on base", commands: [] },
    };
    expect(readProveReport(didNotFail)?.before_fix).toBe("passed");
    const unclear = {
      ...proveReport,
      red: { status: "inconclusive", reason: "crash", commands: [] },
    };
    expect(readProveReport(unclear)?.before_fix).toBe("unknown");
  });

  it("shows a missing stage as unknown, never as passed", () => {
    const noGreen = { ...proveReport, green: undefined };
    expect(readProveReport(noGreen)).toMatchObject({ after_fix: "unknown", before_fix: "failed" });
  });

  it("reads nothing from a report in another shape", () => {
    expect(readProveReport({ tests: 12, passed: 12 })).toBeNull();
    expect(readProveReport({ red: "yes" })).toBeNull();
  });
});

describe("evidence on the ticket page", () => {
  it("sits beside the check, labelled as reported by an agent and not checked by Proofdesk, with no tick", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "attach_evidence"]);
    await attach(app, key, { kind: "test", summary: "Reproduced and fixed", report: proveReport });
    const main = parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
      "main",
    )!;
    // An assistant's evidence is in its one card, under Details.
    const section = main.querySelector(".ticket-summary .assistant-card details.card-details");
    expect(section?.text).toContain("Reproduced and fixed");
    expect(section?.text).toContain("Reported by Helper (AI assistant)");
    expect(section?.text).toContain("Not checked by Proofdesk.");
    expect(section?.querySelectorAll("table.stages td").map((td) => td.text)).toEqual([
      "failed",
      "passed",
      "passed",
    ]);
    expect(main.querySelectorAll("img[src='/assets/mark.svg']")).toHaveLength(0);
  });

  it("is shown to the customer in the Did this fix it? box, in plain words", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await admin(app).post("/api/tickets/SUP-1/evidence").send({
      kind: "check_run",
      summary: "Printed ten pages twice",
      link: "https://example.com/run/1",
    });
    await admin(app).post("/api/tickets/SUP-1/take");
    await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    await admin(app)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await admin(app)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "I printed ten pages.", result: "No jam." });
    const box = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    );
    // One closed line in the question, opened to read the proof.
    const shown = box?.querySelector("details.card-evidence");
    expect(shown?.hasAttribute("open")).toBe(false);
    expect(shown?.querySelector("summary")?.text).toBe("What the team showed (1)");
    expect(shown?.text).toContain("Printed ten pages twice");
    expect(box?.querySelector("a[href='https://example.com/run/1']")).not.toBeNull();
  });
});

describe("the evidence form on the ticket page", () => {
  it("lets the team attach it, labelled as reported by them, leaving the ticket open", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/evidence")
      .type("form")
      .send({ kind: "check_run", summary: "Printed ten pages twice", link: "" });
    expect(res.status).toBe(303);
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    // Evidence a person attached is one closed line, "Evidence (1)", with no heading.
    const section = html.querySelector(".ticket-summary details.evidence-list");
    expect(section?.querySelector("summary")?.text).toBe("Evidence (1)");
    expect(section?.text).toContain("Printed ten pages twice");
    expect(section?.text).toContain("Reported by Team Member");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("new");
  });

  it("is not offered to the customer, who is refused if they try", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(html.querySelector("form[action$='/evidence']")).toBeNull();
    const reason = await refusedBackToTicket(as(app, customerOne), "/tickets/SUP-1/evidence", {
      kind: "note",
      summary: "x",
    });
    expect(reason).toBe("You are not allowed to do that.");
  });

  it("keeps the form open with the message when the summary is missing", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const res = await as(app, teamActor)
      .post("/tickets/SUP-1/evidence")
      .type("form")
      .send({ kind: "note", summary: "" });
    expect(res.status).toBe(400);
    expect(parse(res.text).querySelector("#evidence-error")?.text).toMatch(/one line/);
  });
});

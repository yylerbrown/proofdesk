import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// The question to the customer: the same ask again is a retry; a different one waits for the
// owner to withdraw the first. And nothing internal ever reaches the customer.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};
const ask = {
  try_url: "https://example.com/print",
  tried: "Printed ten pages.",
  result: "No jam.",
};

async function asked(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await as(app, teamActor)
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/c" });
  return (await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask)).body;
}

describe("asking again", () => {
  it("with the very same details is a retry: one question, one history entry", async () => {
    const { app } = buildTestApp();
    const first = await asked(app);
    const again = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
    expect(again.status).toBe(200);
    expect(again.body.ready_token).toBe(first.ready_token);
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.filter((e) => e.type === "ready_for_customer")).toHaveLength(1);
  });

  it("with different details is refused until the owner withdraws the open question", async () => {
    const { app } = buildTestApp();
    const first = await asked(app);
    const changed = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ ...ask, result: "Different" });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("question_open");
    expect(changed.body.error.hint).toMatch(/Withdraw the open question first/);

    expect((await admin(app).post("/api/tickets/SUP-1/withdraw-question")).status).toBe(403);
    expect((await as(app, teamActor).post("/api/tickets/SUP-1/withdraw-question")).status).toBe(
      200,
    );
    const late = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: first.ready_token });
    expect(late.status).toBe(409);
    const next = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ ...ask, result: "Different" });
    expect(next.status).toBe(200);
    expect(next.body.ready_token).not.toBe(first.ready_token);
    const history = parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
      "main",
    )!.text;
    expect(history).toContain("Question to the customer withdrawn");
  });

  it("offers the owner Withdraw the question on the page, and nobody else", async () => {
    const { app } = buildTestApp();
    await asked(app);
    expect(
      parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
        "form[action$='/withdraw-question']",
      ),
    ).not.toBeNull();
    expect(
      parse((await admin(app).get("/tickets/SUP-1")).text).querySelector(
        "form[action$='/withdraw-question']",
      ),
    ).toBeNull();
    expect(
      parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
        "form[action$='/withdraw-question']",
      ),
    ).toBeNull();
  });
});

describe("what reaches the customer", () => {
  it("never internal text: notes, an agent's raw report, its suggested wording", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "write_notes", "attach_evidence"] });
    const key = parse(res.text).querySelector("input.key")!.getAttribute("value")!;
    await handToAgent(app, "SUP-1", key);
    const agent = (path: string, body: object) =>
      request(app).post(path).set("Authorization", `Bearer ${key}`).send(body);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: "INTERNAL-NOTE-7a1" });
    await agent("/api/tickets/SUP-1/notes", { body: "SUGGESTED-WORDING-7a1" });
    await agent("/api/tickets/SUP-1/evidence", {
      kind: "test",
      summary: "Ran the tests",
      report: {
        log: "RAW-REPORT-7a1",
        baseline: { status: "held" },
        red: { status: "held", failureMessage: "x" },
        green: { status: "held" },
      },
    });

    const customerHtml = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    const customerJson = JSON.stringify([
      (await as(app, customerOne).get("/api/tickets/SUP-1")).body,
      (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body,
      (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body,
      (await as(app, customerOne).get("/api/tickets/SUP-1/evidence")).body,
    ]);
    for (const marker of ["INTERNAL-NOTE-7a1", "SUGGESTED-WORDING-7a1", "RAW-REPORT-7a1"]) {
      expect(customerHtml, marker).not.toContain(marker);
      expect(customerJson, marker).not.toContain(marker);
    }
    // The team sees both.
    const teamHtml = (await as(app, teamActor).get("/tickets/SUP-1")).text;
    expect(teamHtml).toContain("INTERNAL-NOTE-7a1");
    expect(teamHtml).toContain("SUGGESTED-WORDING-7a1");
    // The customer still reads what the evidence says, and the team gets the raw report.
    expect(customerJson).toContain("Ran the tests");
    const teamEvidence = JSON.stringify((await admin(app).get("/api/tickets/SUP-1/evidence")).body);
    expect(teamEvidence).toContain("RAW-REPORT-7a1");
  });
});

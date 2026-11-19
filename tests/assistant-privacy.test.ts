import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// An assistant's working stays with the team until a person decides otherwise: only wording it
// suggests for the customer is offered for publishing, the team's message box starts as an
// internal note while it is at work, and its evidence reaches the customer only when the owner
// chose it in a question to them.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

async function handed() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const page = await admin(app)
    .post("/connections")
    .type("form")
    .send({
      name: "Helper",
      scopes: ["read_tickets", "write_notes", "attach_evidence", "propose_specs"],
    });
  const key = parse(page.text).querySelector("input.key")!.getAttribute("value")!;
  await handToAgent(app, "SUP-1", key);
  const agent = (path: string, body: object) =>
    request(app).post(`/api/tickets/SUP-1${path}`).set("Authorization", `Bearer ${key}`).send(body);
  return { app, agent };
}

const teamPage = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets/SUP-1")).text);

describe("publishing an assistant's note as a reply", () => {
  it("is offered only on wording it suggested for the customer, never on a review request", async () => {
    const { app, agent } = await handed();
    await agent("/notes", { body: "Reproduced it locally." });
    await agent("/notes", { body: "Fixed, please try again.", suggested_reply: true });
    await agent("/owner-review", { message: "Evidence attached." });
    const html = await teamPage(app);
    const notes = html.querySelectorAll("article.entry.note");
    const offered = notes.filter((n) => n.querySelector("details.publish") !== null);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.text).toContain("Fixed, please try again.");
  });

  it("records a review request as its own kind of note, with its own history entry", async () => {
    const { app, agent } = await handed();
    const res = await agent("/owner-review", { message: "Evidence attached." });
    expect(res.body).toMatchObject({ kind: "note", purpose: "review_request" });
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.at(-1)?.type).toBe("review_requested");
    expect(events.map((e) => e.type)).not.toContain("note_added");
    const customer = (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body;
    expect(JSON.stringify(customer)).not.toContain("review_requested");
  });
});

describe("the team's message box", () => {
  it("starts as an internal note once an assistant is at work, and as a reply otherwise", async () => {
    const plain = buildTestApp();
    await as(plain.app, customerOne).post("/api/tickets").send(valid);
    const before = await teamPage(plain.app);
    expect(before.querySelector("input[name=kind][value=reply]")?.hasAttribute("checked")).toBe(
      true,
    );
    const { app } = await handed();
    const html = await teamPage(app);
    expect(html.querySelector("input[name=kind][value=note]")?.hasAttribute("checked")).toBe(true);
    expect(html.querySelector("input[name=kind][value=reply]")?.hasAttribute("checked")).toBe(
      false,
    );
  });
});

describe("an assistant's evidence and the customer", () => {
  it("reaches the customer once the owner asks with it, without a scenario of a spec they cannot see", async () => {
    const { app, agent } = await handed();
    await agent("/spec", {
      summary: "Ten pages print.",
      scenarios: [
        { title: "Ten pages", given: "a printer", when: "I print ten pages", then: "no jam" },
      ],
    });
    const evidence = await agent("/evidence", {
      kind: "test",
      summary: "Printed ten pages",
      scenario: 1,
    });
    const early = (await as(app, customerOne).get("/api/tickets/SUP-1/evidence")).body;
    expect(early).toEqual([]);
    // The team sees it at once, with its scenario.
    const team = (await as(app, teamActor).get("/api/tickets/SUP-1/evidence")).body;
    expect(team[0]).toMatchObject({ summary: "Printed ten pages", scenario: 1 });

    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({
        try_url: "https://example.com/t",
        tried: "Printed.",
        result: "No jam.",
        evidence_ids: [evidence.body.id],
      });
    const asked = (await as(app, customerOne).get("/api/tickets/SUP-1/evidence")).body;
    expect(asked).toEqual([
      expect.objectContaining({ summary: "Printed ten pages", scenario: null }),
    ]);
    const box = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    )!;
    expect(box.text).toContain("Printed ten pages");
    expect(box.text).not.toContain("scenario 1");
  });

  it("shows the scenario to the customer once the team has accepted the spec", async () => {
    const { app, agent } = await handed();
    await agent("/spec", {
      summary: "Ten pages print.",
      scenarios: [
        { title: "Ten pages", given: "a printer", when: "I print ten pages", then: "no jam" },
      ],
    });
    const evidence = await agent("/evidence", {
      kind: "test",
      summary: "Printed ten pages",
      scenario: 1,
    });
    await as(app, teamActor)
      .post("/tickets/SUP-1/spec/decision")
      .type("form")
      .send({ decision: "accept" });
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({
        try_url: "https://example.com/t",
        tried: "Printed.",
        result: "No jam.",
        evidence_ids: [evidence.body.id],
      });
    const seen = (await as(app, customerOne).get("/api/tickets/SUP-1/evidence")).body;
    expect(seen[0]).toMatchObject({ scenario: 1 });
  });
});

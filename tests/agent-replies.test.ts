import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// Agents never send a reply the customer sees. Their suggested wording is an internal note,
// and a person may publish it as their own reply, which keeps where it came from for the team.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function agentWithEveryScope(app: Express) {
  // Every scope there is, read from the list itself so a new one is never left out. The first
  // test below also adds "send_replies", as an old key might still hold.
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
  const key = keyOnPage(res.text);
  return key;
}

describe("an agent and the customer", () => {
  it("cannot send a reply the customer sees, even with an old key that names send_replies", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await agentWithEveryScope(app);
    db.prepare("UPDATE agent_connections SET scopes = ?").run(
      JSON.stringify([...AGENT_SCOPES, "send_replies"]),
    );
    await handToAgent(app, "SUP-1", key);
    const reply = await request(app)
      .post("/api/tickets/SUP-1/entries")
      .set("Authorization", `Bearer ${key}`)
      .send({ kind: "reply", body: "Fixed, try now!" });
    expect(reply.status).toBe(403);
    const note = await request(app)
      .post("/api/tickets/SUP-1/notes")
      .set("Authorization", `Bearer ${key}`)
      .send({ body: "Suggested reply: fixed, please try again." });
    expect(note.status).toBe(201);
    // The customer sees neither the note nor any trace of it.
    const customerView = (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body as {
      body: string;
    }[];
    expect(JSON.stringify(customerView)).not.toContain("Suggested reply");
    const customerEvents = JSON.stringify(
      (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body,
    );
    expect(customerEvents).not.toContain("note_added");
  });
});

describe("publishing an agent's suggestion", () => {
  it("lets a person send it, edited, as their own reply, with its source shown to the team only", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await agentWithEveryScope(app);
    await handToAgent(app, "SUP-1", key);
    const note = (
      await request(app)
        .post("/api/tickets/SUP-1/notes")
        .set("Authorization", `Bearer ${key}`)
        // Wording the assistant suggests for the customer: the only kind of note offered to publish.
        .send({ body: "Fixed, please try again.", suggested_reply: true })
    ).body;

    const team = parse((await admin(app).get("/tickets/SUP-1")).text);
    const form = team.querySelector("details.publish form");
    expect(form?.querySelector("textarea")?.text).toBe("Fixed, please try again.");
    expect(form?.querySelector("input[name=based_on]")?.getAttribute("value")).toBe(
      String(note.id),
    );

    const sent = await admin(app)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({
        kind: "reply",
        body: "Fixed: double-sided printing works now. Please try again.",
        based_on: String(note.id),
      });
    expect(sent.status).toBe(303);
    const entries = (await admin(app).get("/api/tickets/SUP-1/entries")).body as {
      kind: string;
      author_name: string;
      author_kind: string;
      based_on: number | null;
    }[];
    expect(entries.at(-1)).toMatchObject({
      kind: "reply",
      author_name: "Admin",
      author_kind: "person",
      based_on: note.id,
    });
    const teamPage = (await admin(app).get("/tickets/SUP-1")).text;
    expect(teamPage).toContain("Published from a note by Helper (AI assistant)");
    const customer = await as(app, customerOne).get("/tickets/SUP-1");
    expect(customer.text).toContain("double-sided printing works now");
    expect(customer.text).not.toContain("Published from a note");
    const customerEntries = (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body as {
      based_on: number | null;
    }[];
    expect(customerEntries.every((e) => e.based_on === null)).toBe(true);
  });

  it("refuses a reply based on something that is not a note on this ticket", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const reply = (
      await as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "reply", body: "Hello" })
    ).body;
    const res = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "x", based_on: reply.id });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.based_on).toBeDefined();
  });
});

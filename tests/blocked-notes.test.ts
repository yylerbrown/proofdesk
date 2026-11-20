import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// An assistant that is blocked says so in a note marked blocked, and the team sees it beside
// the check and in the list, until the same assistant writes another note, attaches evidence or
// asks the owner to review. The note itself stays in the conversation.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function handed() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const page = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes", "attach_evidence"] });
  const key = keyOnPage(page.text);
  await handToAgent(app, "SUP-1", key);
  const note = (body: object) =>
    request(app).post("/api/tickets/SUP-1/notes").set("Authorization", `Bearer ${key}`).send(body);
  const write = (path: string, body: object) =>
    request(app)
      .post(`/api/tickets/SUP-1/${path}`)
      .set("Authorization", `Bearer ${key}`)
      .send(body);
  return { app, note, write };
}

const blockedLine = async (app: Express, who: typeof teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text).querySelector(".assistant-blocked")?.text;
/** The quiet tag after the one ticket's status in the team's list, or null when there is none. */
const listTag = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets")).text).querySelector("table.tickets .turn-tag")
    ?.text ?? null;

describe("an assistant that is blocked", () => {
  it("is shown to the team beside the check and in the list, with its note's first line", async () => {
    const { app, note } = await handed();
    const res = await note({
      body: "I cannot run code in this environment.\nThe repository needs a build step I lack.",
      blocked: true,
    });
    expect(res.status).toBe(201);
    expect(await blockedLine(app, teamActor)).toBe(
      "Assistant blocked: I cannot run code in this environment.",
    );
    expect(await listTag(app)).toBe("Assistant is blocked");
    // The note is internal, so the customer sees nothing of it.
    expect(await blockedLine(app, customerOne)).toBeUndefined();
    const own = parse((await as(app, customerOne).get("/tickets")).text).querySelector(
      "main",
    )!.text;
    expect(own).not.toContain("Assistant blocked");
  });

  it("stops being shown once the assistant writes an ordinary note", async () => {
    const { app, note } = await handed();
    await note({ body: "Blocked on access.", blocked: true });
    await note({ body: "Access granted, carrying on." });
    expect(await blockedLine(app, teamActor)).toBeUndefined();
    expect(await listTag(app)).toBeNull();
  });

  it("stops being shown once the same assistant attaches evidence, and its note stays", async () => {
    const { app, note, write } = await handed();
    await note({ body: "Blocked on access to the print server.", blocked: true });
    expect(await blockedLine(app, teamActor)).toBeDefined();
    const attached = await write("evidence", {
      kind: "test",
      summary: "Ran it",
      result: "3 passed",
    });
    expect(attached.status).toBe(201);
    expect(await blockedLine(app, teamActor)).toBeUndefined();
    expect(await listTag(app)).toBeNull();
    // Nothing is deleted: the note is still in the conversation.
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector("article.entry.note")?.text).toContain(
      "Blocked on access to the print server.",
    );
  });

  it("stops being shown once the same assistant asks the owner to review", async () => {
    const { app, note, write } = await handed();
    await note({ body: "Blocked on access.", blocked: true });
    const asked = await write("owner-review", { message: "Please review the evidence." });
    expect(asked.status).toBe(201);
    expect(await blockedLine(app, teamActor)).toBeUndefined();
    expect(await listTag(app)).not.toBe("Assistant is blocked");
  });

  it("is a mark only an assistant can make", async () => {
    const { app } = await handed();
    const res = await as(app, teamActor)
      .post("/api/tickets/SUP-1/notes")
      .send({ body: "I am blocked too.", blocked: true });
    expect(res.status).toBe(201);
    expect(await blockedLine(app, teamActor)).toBeUndefined();
  });
});

import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// An assistant that is blocked says so in a note marked blocked, and the team sees it beside
// the check and in the list, until the assistant writes an ordinary note again.

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
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
  const key = parse(page.text).querySelector("input.key")!.getAttribute("value")!;
  await handToAgent(app, "SUP-1", key);
  const note = (body: object) =>
    request(app).post("/api/tickets/SUP-1/notes").set("Authorization", `Bearer ${key}`).send(body);
  return { app, note };
}

const blockedLine = async (app: Express, who: typeof teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text).querySelector(".assistant-blocked")?.text;
/** The list's "Waiting on" cell for the one ticket: the fifth column. */
const waitingCell = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets")).text).querySelectorAll(
    "table.tickets tbody tr td",
  )[4]?.text;

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
    expect(await waitingCell(app)).toBe(
      "Assistant blocked: I cannot run code in this environment.",
    );
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
    expect(await waitingCell(app)).toBe("Support team");
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

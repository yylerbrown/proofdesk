import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { expect } from "vitest";
import type { Db } from "../src/server/db.js";
import {
  admin,
  adminActor,
  as,
  customerOne,
  customerTwo,
  handToAgent,
  teamActor,
} from "./helpers.js";

// The ticket life that the email notice tests share.

/** Every internal note in the life carries this, so a test can look for it in every notice. */
export const NOTE_MARKER = "INTERNAL-ONLY-7731";

/** Gives the made-up people of the development entrance an address, as signing in would. */
export function giveAddresses(db: Db) {
  const insert = db.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, '2026-01-01', '2026-01-01')`,
  );
  for (const person of [customerOne, customerTwo, teamActor, adminActor]) {
    insert.run(person.id, person.name, `${person.id}@example.com`);
  }
}

export async function ok(res: request.Response | Promise<request.Response>, status = 200) {
  const done = await res;
  expect(done.status, done.text).toBe(status);
  return done;
}

async function issueKey(app: Express): Promise<string> {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "attach_evidence", "write_notes"] });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

/**
 * A full ticket life, with afterStep run after every step, as the server collects notices after
 * every request that changed something. On SUP-1: filed, taken,
 * a team reply, an internal note, an assistant's evidence and note, the customer asked, a No,
 * a hand-off, a reply from the customer, asked again, a Yes. On SUP-2: a team resolution, then
 * a reopen.
 */
export async function fullLife(app: Express, afterStep: () => unknown) {
  const step = async (res: Promise<request.Response>, status = 200) => {
    const done = await ok(res, status);
    await afterStep();
    return done;
  };
  await step(
    as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "On page two.", fix_check: "Ten pages print" }),
    201,
  );
  await step(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
  await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Looking at it now." }),
    201,
  );
  await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: `Customer seems upset. ${NOTE_MARKER}` }),
    201,
  );
  const key = await issueKey(app);
  await handToAgent(app, "SUP-1", key);
  await afterStep();
  const agent = (path: string) => request(app).post(path).set("Authorization", `Bearer ${key}`);
  await step(
    agent("/api/tickets/SUP-1/evidence").send({
      kind: "test",
      summary: "A test prints ten pages",
      link: "https://example.com/pr/7",
      result: "passed",
    }),
    201,
  );
  await step(
    agent("/api/tickets/SUP-1/notes").send({ body: `Root cause found. ${NOTE_MARKER}` }),
    201,
  );
  await step(
    as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/change/1" }),
  );
  const first = await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/try", tried: "Printed ten.", result: "No jam." }),
  );
  await step(
    as(app, customerOne).post("/api/tickets/SUP-1/answer").send({
      fixed: "no",
      comment: "It jammed on page nine.",
      ready_token: first.body.ready_token,
    }),
  );
  await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: adminActor.id, expected_owner: teamActor.id }),
  );
  await step(
    as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "It is the thick paper." }),
    201,
  );
  const second = await step(
    admin(app).post("/api/tickets/SUP-1/ready").send({
      try_url: "https://example.com/try",
      tried: "Printed ten on thick paper.",
      result: "No jam.",
      response: "The thick paper tray is fixed now.",
    }),
  );
  await step(
    as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: second.body.ready_token }),
  );

  await step(
    as(app, customerTwo)
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "The file has no rows." }),
    201,
  );
  await step(admin(app).post("/api/tickets/SUP-2/take-and-start"));
  await step(
    admin(app)
      .post("/api/tickets/SUP-2/resolve")
      .send({ reason: "duplicate", duplicate_of: "SUP-1", note: "Same printer as SUP-1." }),
  );
  await step(
    as(app, customerTwo).post("/api/tickets/SUP-2/reopen").send({ reason: "Still empty today." }),
  );
}

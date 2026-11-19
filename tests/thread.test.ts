import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };
const reply = (body: string) => ({ kind: "reply", body });
const note = (body: string) => ({ kind: "note", body });

/** An app where customer one filed SUP-1, the team replied and left a note, and one replied. */
async function setup() {
  const built = buildTestApp();
  const one = as(built.app, customerOne);
  const team = as(built.app, teamActor);
  await one.post("/api/tickets").send(valid);
  await team.post("/api/tickets/SUP-1/entries").send(reply("Which printer is it?"));
  await team.post("/api/tickets/SUP-1/entries").send(note("Probably the old one on floor 2."));
  await one.post("/api/tickets/SUP-1/entries").send(reply("The one by the window."));
  return built;
}

describe("replies and internal notes", () => {
  it("keeps the conversation in order, with each author as they were when writing", async () => {
    const { app } = await setup();
    const res = await as(app, teamActor).get("/api/tickets/SUP-1/entries");
    expect(
      res.body.map((e: { kind: string; author_role: string; body: string }) => [
        e.kind,
        e.author_role,
        e.body,
      ]),
    ).toEqual([
      ["reply", "team", "Which printer is it?"],
      ["note", "team", "Probably the old one on floor 2."],
      ["reply", "customer", "The one by the window."],
    ]);
    expect(res.body[0]).toMatchObject({ author: teamActor.id, author_name: "Team Member" });
  });

  it("never shows a customer an internal note, anywhere", async () => {
    const { app } = await setup();
    const one = as(app, customerOne);
    const entries = await one.get("/api/tickets/SUP-1/entries");
    expect(entries.body.map((e: { kind: string }) => e.kind)).toEqual(["reply", "reply"]);

    const history = await one.get("/api/tickets/SUP-1/events");
    expect(history.body.map((e: { type: string }) => e.type)).toEqual([
      "created",
      "reply_added",
      "reply_added",
    ]);

    const page = await one.get("/tickets/SUP-1");
    expect(page.text).toContain("Which printer is it?");
    expect(page.text).not.toContain("floor 2");
    expect(page.text).not.toContain("Internal note");
    expect(page.text).not.toContain('value="note"');
  });

  it("shows the team every entry and marks notes as internal", async () => {
    const { app } = await setup();
    const page = await as(app, teamActor).get("/tickets/SUP-1");
    expect(page.text).toContain("Probably the old one on floor 2.");
    expect(page.text).toContain("internal note, the customer does not see this");
    expect(page.text).toContain("Internal note added");
    expect(page.text).toContain('value="note"');
  });

  it("does not let a customer write an internal note", async () => {
    const { app } = await setup();
    const res = await as(app, customerOne).post("/api/tickets/SUP-1/entries").send(note("x"));
    expect(res.status).toBe(403);
    // A page form that tries it is refused too.
    await refusedBackToTicket(as(app, customerOne), "/tickets/SUP-1/entries", note("x"));
    expect((await admin(app).get("/api/tickets/SUP-1/entries")).body).toHaveLength(3);
  });

  it("does not let another customer read or write the conversation", async () => {
    const { app } = await setup();
    const two = as(app, customerTwo);
    expect((await two.get("/api/tickets/SUP-1/entries")).status).toBe(404);
    expect((await two.post("/api/tickets/SUP-1/entries").send(reply("hello"))).status).toBe(404);
  });

  it("refuses an empty or overlong message, and a kind it does not know", async () => {
    const { app } = await setup();
    const team = as(app, teamActor);
    for (const body of [reply("   "), reply("a".repeat(5001)), { kind: "shout", body: "hi" }, {}]) {
      const res = await team.post("/api/tickets/SUP-1/entries").send(body);
      expect(res.status).toBe(400);
    }
    expect((await admin(app).get("/api/tickets/SUP-1/entries")).body).toHaveLength(3);
  });

  it("refuses new entries on an archived ticket", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-1/archive");
    const res = await admin(app).post("/api/tickets/SUP-1/entries").send(reply("hi"));
    expect(res.status).toBe(409);
  });
});

describe("the conversation on the ticket page", () => {
  it("sends a reply from the form and comes back to the conversation", async () => {
    const { app } = await setup();
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send(reply("Thanks!"));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1#sent");
    expect((await as(app, customerOne).get("/tickets/SUP-1")).text).toContain("Thanks!");
  });

  it("shows the page again with the message kept when the text is refused", async () => {
    const { app } = await setup();
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send(reply("a".repeat(5001)));
    expect(res.status).toBe(400);
    expect(res.text).toContain("Must be at most 5000 characters.");
    expect(res.text).toContain(`${"a".repeat(5001)}</textarea>`);
  });

  it("shows a message as text, never as markup", async () => {
    const { app } = await setup();
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send(reply('<script>alert(1)</script><img src=x onerror="alert(2)">'));
    const page = await as(app, teamActor).get("/tickets/SUP-1");
    expect(page.text).not.toMatch(/<script>alert|<img src=x/);
    expect(page.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("permanent deletion and the conversation", () => {
  it("removes every reply and note, also from the files on disk", async () => {
    const { app, db } = await setup();
    const secret = "NOTE-SECRET-41d2";
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send(note(`Card ${secret}`));
    db.pragma("wal_checkpoint(PASSIVE)");
    expect(fs.readFileSync(db.name).includes(secret)).toBe(true);

    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_entries").get()).toEqual({ n: 0 });
    expect(fs.readFileSync(db.name).includes(secret)).toBe(false);
  });
});

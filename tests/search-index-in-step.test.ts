import { describe, expect, it } from "vitest";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne } from "./helpers.js";

// The word index keeps its own copy of every ticket's title and description, and database
// triggers keep that copy in step with the tickets table. A later migration that rebuilds the
// tickets table drops its triggers without an error, and this test is what notices.

type TestDb = ReturnType<typeof buildTestApp>["db"];

/** Each ticket's text, and each index row's text, by id. */
function bothCopies(db: TestDb) {
  const tickets = db.prepare("SELECT id, title, description FROM tickets ORDER BY id").all();
  const index = db
    .prepare("SELECT rowid AS id, title, description FROM ticket_search ORDER BY rowid")
    .all();
  return { tickets, index };
}

describe("the word index", () => {
  it("follows filing, editing, archiving, restoring and permanent deletion", async () => {
    const { app, db } = buildTestApp();
    const one = as(app, customerOne);
    await one.post("/api/tickets").send({ title: "Printer jams", description: "On page two" });
    await one.post("/api/tickets").send({ title: "Invoice date wrong", description: "Last month" });
    await one.post("/api/tickets").send({ title: "Login fails", description: "On my phone" });
    await one.put("/api/tickets/SUP-1").send({ title: "Printer smokes", description: "Hot paper" });
    await admin(app).post("/api/tickets/SUP-2/archive");
    await admin(app).post("/api/tickets/SUP-2/restore");
    await admin(app).post("/api/tickets/SUP-3/archive");
    const deleted = await admin(app).delete("/api/tickets/SUP-2").send({ confirm: "SUP-2" });
    expect(deleted.status).toBe(200);

    const { tickets, index } = bothCopies(db);
    expect(index).toEqual(tickets);
    expect(index.map((row) => (row as { id: number }).id)).toEqual([1, 3]);
    expect(
      db.prepare("SELECT rowid FROM ticket_search WHERE ticket_search MATCH ?").all("hot"),
    ).toEqual([{ rowid: 1 }]);
    expect(
      db.prepare("SELECT rowid FROM ticket_search WHERE ticket_search MATCH ?").all("jams"),
    ).toEqual([]);
  });

  it("holds every ticket of the demo's sample data", () => {
    const { db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const { tickets, index } = bothCopies(db);
    expect(tickets.length).toBeGreaterThan(0);
    expect(index).toEqual(tickets);
  });

  it("passes the word index's own integrity check", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    expect(() =>
      db.prepare("INSERT INTO ticket_search (ticket_search) VALUES ('integrity-check')").run(),
    ).not.toThrow();
  });
});

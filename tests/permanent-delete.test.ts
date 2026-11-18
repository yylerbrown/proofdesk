import fs from "node:fs";
import { openDatabase } from "../src/server/db.js";
import { describe, expect, it } from "vitest";
import { TICKET_TABLES } from "../src/server/tickets/repository.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, adminActor, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

type TestDb = ReturnType<typeof buildTestApp>["db"];

const SECRET = "SENSITIVE-7f3a9c";
const valid = { title: "Printer is broken", description: "It jams on every page." };

/** An app with SUP-1 (filed by customer one, edited, with a status change) and SUP-2. */
async function setup() {
  const built = buildTestApp();
  const one = as(built.app, customerOne);
  await one.post("/api/tickets").send({
    title: `Card ${SECRET}`,
    description: `My card number is ${SECRET}`,
    fix_check: `It works with ${SECRET}`,
  });
  await one.put("/api/tickets/SUP-1").send({ title: `Card ${SECRET} again`, description: SECRET });
  await admin(built.app).post("/api/tickets/SUP-1/take");
  await admin(built.app).post("/api/tickets").send(valid);
  return built;
}

function count(db: TestDb, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

describe("permanent deletion", () => {
  it("removes the ticket and its history, and keeps only who and when", async () => {
    const { app, db } = await setup();
    const res = await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, files_cleaned: true });

    expect(count(db, "SELECT COUNT(*) AS n FROM tickets WHERE id = 1")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = 1")).toBe(0);
    expect(db.prepare("SELECT ticket_id, deleted_by FROM deleted_tickets").all()).toEqual([
      { ticket_id: 1, deleted_by: "dev-admin-1" },
    ]);
    // The other ticket is untouched.
    expect((await admin(app).get("/api/tickets/SUP-2")).body.title).toBe(valid.title);
    expect((await admin(app).get("/api/tickets/SUP-2/events")).body).toHaveLength(1);
  });

  it("leaves no trace of the text in the database files on disk", async () => {
    const { app, db } = await setup();
    const files = [db.name, `${db.name}-wal`];
    const onDisk = () =>
      files.filter(fs.existsSync).some((file) => fs.readFileSync(file).includes(SECRET));
    // Make sure the text really was on disk before, or the check below proves nothing.
    db.pragma("wal_checkpoint(PASSIVE)");
    expect(onDisk()).toBe(true);

    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(onDisk()).toBe(false);
  });

  it("never gives the number to a new ticket", async () => {
    const { app } = await setup();
    await admin(app).delete("/api/tickets/SUP-2").send({ confirm: "SUP-2" });
    const next = await admin(app).post("/api/tickets").send(valid);
    expect(next.body.key).toBe("SUP-3");
  });

  it("answers 'deleted' to the team and the usual 'not found' to a customer", async () => {
    const { app } = await setup();
    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });

    const team = await as(app, teamActor).get("/api/tickets/SUP-1");
    expect(team.status).toBe(410);
    expect(team.body.error.code).toBe("ticket_deleted");
    const page = await as(app, teamActor).get("/tickets/SUP-1");
    expect(page.status).toBe(410);
    expect(page.text).toContain("Ticket SUP-1 was deleted permanently.");

    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).status).toBe(404);
    expect((await as(app, customerOne).get("/api/tickets")).body).toEqual([]);
  });

  it("needs the key typed exactly, and deletes nothing otherwise", async () => {
    const { app, db } = await setup();
    for (const confirm of ["", "SUP-2", "sup-1", "SUP-01"]) {
      const res = await admin(app).delete("/api/tickets/SUP-1").send({ confirm });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    }
    expect((await admin(app).delete("/api/tickets/SUP-1").send({})).status).toBe(400);
    expect(count(db, "SELECT COUNT(*) AS n FROM tickets")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM deleted_tickets")).toBe(0);
  });

  it("is for an admin only", async () => {
    const { app, db } = await setup();
    const team = await as(app, teamActor).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(team.status).toBe(403);
    // Even the customer who filed it.
    const own = await as(app, customerOne).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(own.status).toBe(403);
    expect(count(db, "SELECT COUNT(*) AS n FROM tickets")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM ticket_events")).toBe(4);
  });

  it("works on an archived ticket", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-1/archive");
    const res = await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, files_cleaned: true });
  });
});

describe("the rules that keep deletion honest", () => {
  it("covers every table that has a ticket_id column", () => {
    const { db } = buildTestApp();
    const tables = db
      .prepare(
        `SELECT m.name FROM sqlite_master AS m, pragma_table_info(m.name) AS c
         WHERE m.type = 'table' AND c.name = 'ticket_id' ORDER BY m.name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);
    // deleted_tickets is the record of the deletion itself.
    expect(tables).toEqual([...TICKET_TABLES, "deleted_tickets"].sort());
  });

  it("still refuses to remove the events of a ticket that was not deleted", async () => {
    const { db } = await setup();
    expect(() => db.prepare("DELETE FROM ticket_events WHERE ticket_id = 2").run()).toThrow(
      /append-only/,
    );
  });

  it("never changes or removes the record of a deletion", async () => {
    const { app, db } = await setup();
    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(() => db.prepare("UPDATE deleted_tickets SET deleted_by = 'x'").run()).toThrow(
      /cannot be changed/,
    );
    expect(() => db.prepare("DELETE FROM deleted_tickets").run()).toThrow(/cannot be removed/);
  });
});

describe("permanent deletion on the pages", () => {
  it("offers the link to an admin only", async () => {
    const { app } = await setup();
    expect((await admin(app).get("/tickets/SUP-1")).text).toContain('href="/tickets/SUP-1/delete"');
    expect((await as(app, teamActor).get("/tickets/SUP-1")).text).not.toContain("/delete");
    expect((await as(app, teamActor).get("/tickets/SUP-1/delete")).status).toBe(403);
  });

  it("asks for the key, refuses a wrong one, and deletes on the right one", async () => {
    const { app } = await setup();
    const page = await admin(app).get("/tickets/SUP-1/delete");
    expect(page.text).toContain("Type SUP-1 to confirm");
    expect(page.text).toContain("It does not reach backups");

    const wrong = await admin(app)
      .post("/tickets/SUP-1/delete")
      .type("form")
      .send({ confirm: "x" });
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain("Type SUP-1 to confirm.");
    expect((await admin(app).get("/api/tickets/SUP-1")).status).toBe(200);

    const right = await admin(app)
      .post("/tickets/SUP-1/delete")
      .type("form")
      .send({ confirm: "SUP-1" });
    expect(right.status).toBe(200);
    expect(right.text).toContain("SUP-1 was deleted");
    expect(right.text).toContain("The files on disk have been cleaned as well");
    expect((await admin(app).get("/api/tickets/SUP-1")).status).toBe(410);
  });
});

describe("when the files on disk cannot be cleaned at once", () => {
  it("says so, instead of claiming the text is gone from disk", async () => {
    const { app, db } = await setup();
    // Another connection to the same file, in the middle of reading.
    const reader = openDatabase(db.name);
    try {
      reader.prepare("BEGIN").run();
      reader.prepare("SELECT * FROM tickets").all();

      const startedAt = Date.now();
      const res = await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
      expect(res.body).toEqual({ deleted: true, files_cleaned: false });
      // It does not wait for the reader, which would hold up every other request.
      expect(Date.now() - startedAt).toBeLessThan(1000);
      // Gone from the database all the same.
      expect((await admin(app).get("/api/tickets/SUP-1")).status).toBe(410);

      const page = await admin(app)
        .post("/tickets/SUP-2/delete")
        .type("form")
        .send({ confirm: "SUP-2" });
      expect(page.text).toContain("The files on disk are not cleaned yet.");
    } finally {
      reader.prepare("COMMIT").run();
      reader.close();
    }
  });
});

describe("permanent deletion covers every column that holds text", () => {
  it("leaves the marker nowhere on disk, wherever it was written", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const mark = "EVERYCOLUMN-5be1";
    // A team member whose name carries the marker, so it lands in owner_name too.
    const team = {
      id: "team-x",
      kind: "person" as const,
      role: "team" as const,
      name: `Sam ${mark}`,
    };
    const customer = {
      id: "cust-x",
      kind: "person" as const,
      role: "customer" as const,
      name: "C",
    };
    service.createTicket(
      {
        title: `T ${mark}`,
        description: `D ${mark}`,
        where_url: `https://example.com/${mark}`,
        fix_check: `C ${mark}`,
      },
      customer,
    );
    service.takeTicket("SUP-1", team);
    service.changeStatus("SUP-1", { status: "in_progress" }, team);
    service.agreeCheck("SUP-1", { agreed_check: `A ${mark}` }, team);
    service.addEntry("SUP-1", { kind: "note", body: `N ${mark}` }, team);
    service.linkChange("SUP-1", { change_url: `https://example.com/change/${mark}` }, team);
    const ready = service.markReady("SUP-1", { try_url: `https://example.com/try/${mark}` }, team);
    service.answer(
      "SUP-1",
      { fixed: "no", comment: `Still broken ${mark}`, ready_token: ready.ready_token },
      customer,
    );
    const onDisk = () =>
      [db.name, `${db.name}-wal`]
        .filter(fs.existsSync)
        .some((file) => fs.readFileSync(file).includes(mark));
    db.pragma("wal_checkpoint(PASSIVE)");
    expect(onDisk()).toBe(true);

    const result = service.deleteTicket("SUP-1", { confirm: "SUP-1" }, adminActor);
    expect(result.filesCleaned).toBe(true);
    expect(onDisk()).toBe(false);
  });
});

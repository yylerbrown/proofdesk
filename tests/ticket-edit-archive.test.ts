import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, adminActor, buildTestApp } from "./helpers.js";

type TestDb = ReturnType<typeof buildTestApp>["db"];

const actor = adminActor;
const original = {
  title: "Printer is broken",
  description: "It jams.",
  where_url: "https://example.com/print",
  fix_check: "Ten pages print.",
};

function eventCount(db: TestDb): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get() as { n: number }).n;
}

function breakEventInserts(db: TestDb) {
  db.exec(
    `CREATE TRIGGER fail_event_insert BEFORE INSERT ON ticket_events
     BEGIN SELECT RAISE(ABORT, 'event insert failed'); END`,
  );
}

function setup() {
  const { app, db } = buildTestApp();
  const service = createTicketService(db, "SUP");
  service.createTicket(original, actor);
  return { app, db, service };
}

describe("editing a ticket (service)", () => {
  it("changes the text and records each changed field with its old and new value", () => {
    const { service } = setup();
    const edited = service.editTicket(
      "SUP-1",
      { ...original, title: "Printer jams on every page", fix_check: "" },
      { id: "helper-1", kind: "agent", role: "team", name: "Helper" },
    );
    expect(edited).toMatchObject({
      title: "Printer jams on every page",
      description: original.description,
      where_url: original.where_url,
      fix_check: null,
      status: "new",
    });
    expect(edited).toEqual(service.getTicket("SUP-1", actor));

    const last = service.listEvents("SUP-1", actor).at(-1);
    expect(last).toMatchObject({
      type: "edited",
      actor: "helper-1",
      actor_kind: "agent",
      data: {
        changes: {
          title: { from: original.title, to: "Printer jams on every page" },
          fix_check: { from: original.fix_check, to: null },
        },
      },
    });
  });

  it("writes nothing when the text is the same, even with extra spaces around it", () => {
    const { db, service } = setup();
    const before = service.getTicket("SUP-1", actor);
    const after = service.editTicket(
      "SUP-1",
      { ...original, title: `  ${original.title} ` },
      actor,
    );
    expect(after).toEqual(before);
    expect(eventCount(db)).toBe(1);
  });

  it("applies the same rules as a new ticket and writes nothing when they are broken", () => {
    const { db, service } = setup();
    const before = service.getTicket("SUP-1", actor);
    expect(() => service.editTicket("SUP-1", { ...original, title: "ab" }, actor)).toThrow(
      ValidationError,
    );
    expect(() =>
      service.editTicket("SUP-1", { ...original, where_url: "javascript:alert(1)" }, actor),
    ).toThrow(ValidationError);
    expect(service.getTicket("SUP-1", actor)).toEqual(before);
    expect(eventCount(db)).toBe(1);
  });

  it("cannot change fields that are not ticket text", () => {
    const { service } = setup();
    const edited = service.editTicket(
      "SUP-1",
      {
        ...original,
        title: "A new title",
        status: "resolved",
        created_by: "someone-else",
        owner_id: "someone-else",
        archived_at: "2026-01-01T00:00:00.000Z",
        key: "SUP-2",
      },
      actor,
    );
    expect(edited).toMatchObject({
      key: "SUP-1",
      status: "new",
      created_by: "dev-admin-1",
      owner_id: null,
      archived_at: null,
    });
  });

  it("leaves the ticket exactly as it was when the event insert fails", () => {
    const { db, service } = setup();
    const before = service.getTicket("SUP-1", actor);
    breakEventInserts(db);
    expect(() => service.editTicket("SUP-1", { ...original, title: "A new title" }, actor)).toThrow(
      /event insert failed/,
    );
    expect(service.getTicket("SUP-1", actor)).toEqual(before);
  });
});

describe("archiving and restoring a ticket (service)", () => {
  it("hides an archived ticket from every ordinary list and shows it in the archived list", () => {
    const { service } = setup();
    service.createTicket({ ...original, title: "Second ticket" }, actor);
    const archived = service.archiveTicket("SUP-1", actor);
    expect(archived.archived_at).not.toBeNull();

    const keys = (filter: Parameters<typeof service.listTickets>[0]) =>
      service.listTickets(filter, actor).map((t) => t.key);
    expect(keys("all")).toEqual(["SUP-2"]);
    expect(keys("new")).toEqual(["SUP-2"]);
    expect(keys("archived")).toEqual(["SUP-1"]);
  });

  it("keeps the ticket and its history, and restore brings it back", () => {
    const { service } = setup();
    service.archiveTicket("SUP-1", actor);
    const restored = service.restoreTicket("SUP-1", actor);
    expect(restored.archived_at).toBeNull();
    expect(restored).toMatchObject(original);
    expect(service.listTickets("all", actor).map((t) => t.key)).toEqual(["SUP-1"]);
    expect(service.listTickets("archived", actor)).toEqual([]);
    expect(service.listEvents("SUP-1", actor).map((e) => e.type)).toEqual([
      "created",
      "archived",
      "restored",
    ]);
  });

  it("writes one event per real change and none when repeated", () => {
    const { db, service } = setup();
    service.restoreTicket("SUP-1", actor); // not archived: nothing happens
    expect(eventCount(db)).toBe(1);
    service.archiveTicket("SUP-1", actor);
    const again = service.archiveTicket("SUP-1", actor);
    expect(eventCount(db)).toBe(2);
    expect(again).toEqual(service.getTicket("SUP-1", actor));
  });

  it("refuses to edit or change the status of an archived ticket", () => {
    const { db, service } = setup();
    service.archiveTicket("SUP-1", actor);
    const before = service.getTicket("SUP-1", actor);
    expect(() => service.editTicket("SUP-1", { ...original, title: "A new title" }, actor)).toThrow(
      /is archived/,
    );
    expect(() => service.changeStatus("SUP-1", { status: "resolved" }, actor)).toThrow(
      /is archived/,
    );
    expect(service.getTicket("SUP-1", actor)).toEqual(before);
    expect(eventCount(db)).toBe(2);
  });

  it("leaves the ticket exactly as it was when the event insert fails", () => {
    const { db, service } = setup();
    const before = service.getTicket("SUP-1", actor);
    breakEventInserts(db);
    expect(() => service.archiveTicket("SUP-1", actor)).toThrow(/event insert failed/);
    expect(service.getTicket("SUP-1", actor)).toEqual(before);
  });

  it("never removes a row: archiving deletes nothing from either table", () => {
    const { db, service } = setup();
    service.archiveTicket("SUP-1", actor);
    expect(db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 1 });
    expect(eventCount(db)).toBe(2);
  });
});

describe("edit, archive and restore over the JSON API", () => {
  it("replaces the text with PUT and returns the ticket", async () => {
    const { app } = setup();
    const res = await admin(app)
      .put("/api/tickets/SUP-1")
      .send({ title: "A new title", description: "A new description" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      key: "SUP-1",
      title: "A new title",
      description: "A new description",
      where_url: null,
      fix_check: null,
    });
  });

  it("returns 400 for text that breaks the rules, 404 for an unknown ticket", async () => {
    const { app } = setup();
    const bad = await admin(app).put("/api/tickets/SUP-1").send({ title: "ab" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("validation_error");
    const missing = await admin(app).put("/api/tickets/SUP-9").send(original);
    expect(missing.status).toBe(404);
  });

  it("archives, lists and restores", async () => {
    const { app } = setup();
    const archived = await admin(app).post("/api/tickets/SUP-1/archive");
    expect(archived.status).toBe(200);
    expect(archived.body.archived_at).not.toBeNull();

    expect((await admin(app).get("/api/tickets")).body).toEqual([]);
    const list = await admin(app).get("/api/tickets?status=archived");
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);

    const refused = await admin(app).patch("/api/tickets/SUP-1").send({ status: "resolved" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("ticket_archived");

    const restored = await admin(app).post("/api/tickets/SUP-1/restore");
    expect(restored.body.archived_at).toBeNull();
    expect((await admin(app).get("/api/tickets")).body).toHaveLength(1);
  });

  it("returns 404 when archiving or restoring an unknown ticket", async () => {
    const { app } = setup();
    expect((await admin(app).post("/api/tickets/SUP-9/archive")).status).toBe(404);
    expect((await admin(app).post("/api/tickets/SUP-9/restore")).status).toBe(404);
  });
});

describe("edit, archive and restore on the pages", () => {
  it("shows the edit form filled in with the ticket as it is", async () => {
    const { app } = setup();
    const res = await admin(app).get("/tickets/SUP-1/edit");
    expect(res.status).toBe(200);
    expect(res.text).toContain('<form method="post" action="/tickets/SUP-1/edit">');
    expect(res.text).toContain(`value="${original.title}"`);
    expect(res.text).toContain(`${original.description}</textarea>`);
    expect(res.text).toContain(`value="${original.where_url}"`);
    expect(res.text).toContain("Save changes");
  });

  it("saves an edit, redirects to the ticket and shows it in the history", async () => {
    const { app } = setup();
    const res = await admin(app)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...original, title: "A new title", where_url: "" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1");

    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.text).toContain("A new title");
    expect(page.text).toContain("Edited: title, where it happened");
    expect(page.text).not.toContain(original.where_url);
  });

  it("shows the edit form again with messages when the text breaks the rules", async () => {
    const { app, db } = setup();
    const res = await admin(app)
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...original, title: '"><script>alert(1)</script>'.padEnd(130, "x") });
    expect(res.status).toBe(400);
    expect(res.text).toContain("Must be at most 120 characters.");
    expect(res.text).toContain('action="/tickets/SUP-1/edit"');
    expect(res.text).not.toContain("<script>");
    expect(eventCount(db)).toBe(1);
  });

  it("returns an HTML 404 page when editing a ticket that does not exist", async () => {
    const { app } = setup();
    expect((await admin(app).get("/tickets/SUP-9/edit")).status).toBe(404);
    const post = await admin(app).post("/tickets/SUP-9/edit").type("form").send(original);
    expect(post.status).toBe(404);
    expect(post.headers["content-type"]).toMatch(/html/);
  });

  it("archives from the ticket page, hides it from the list and offers to restore it", async () => {
    const { app } = setup();
    const res = await admin(app).post("/tickets/SUP-1/archive");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets");

    const list = await admin(app).get("/tickets");
    expect(list.text).not.toContain(original.title);
    const archivedList = await admin(app).get("/tickets?status=archived");
    expect(archivedList.text).toContain(original.title);

    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.text).toContain("This ticket was archived");
    expect(page.text).toContain('action="/tickets/SUP-1/restore"');
    expect(page.text).not.toContain('action="/tickets/SUP-1/status"');
    expect(page.text).not.toContain('href="/tickets/SUP-1/edit"');
    expect(page.text).toContain("<td>Archived</td>");
  });

  it("restores from the ticket page and shows the controls again", async () => {
    const { app } = setup();
    await admin(app).post("/tickets/SUP-1/archive");
    const res = await admin(app).post("/tickets/SUP-1/restore");
    expect(res.status).toBe(303);

    const page = await admin(app).get("/tickets/SUP-1");
    expect(page.text).not.toContain("This ticket was archived");
    expect(page.text).toContain('action="/tickets/SUP-1/status"');
    expect(page.text).toContain("<td>Restored</td>");
    expect((await admin(app).get("/tickets")).text).toContain(original.title);
  });

  it("answers a change to an archived ticket with an HTML page that says why", async () => {
    const { app } = setup();
    await admin(app).post("/tickets/SUP-1/archive");
    const res = await admin(app)
      .post("/tickets/SUP-1/status")
      .type("form")
      .send({ status: "resolved" });
    expect(res.status).toBe(409);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("Ticket SUP-1 is archived. Restore it first.");
  });
});

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { openDatabase } from "../src/server/db.js";
import { ValidationError } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne } from "./helpers.js";

type TestDb = ReturnType<typeof buildTestApp>["db"];

const actor = adminActor;
const input = { title: "Printer is broken", description: "It jams." };

// A trigger that makes every insert into ticket_events fail, to prove the ticket change and
// its event are one transaction.
function breakEventInserts(db: TestDb) {
  db.exec(
    `CREATE TRIGGER fail_event_insert BEFORE INSERT ON ticket_events
     BEGIN SELECT RAISE(ABORT, 'event insert failed'); END`,
  );
}

function count(db: TestDb, table: "tickets" | "ticket_events"): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ticket service transactions", () => {
  it("leaves the ticket exactly as it was when the event insert fails", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(input, actor);
    service.takeTicket("SUP-1", actor);
    const before = service.getTicket("SUP-1", actor);

    breakEventInserts(db);
    expect(() => service.changeStatus("SUP-1", { status: "in_progress" }, actor)).toThrow(
      /event insert failed/,
    );

    expect(service.getTicket("SUP-1", actor)).toEqual(before);
    expect(count(db, "ticket_events")).toBe(2);
  });

  it("leaves both tables empty when the creation event fails", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");

    breakEventInserts(db);
    expect(() => service.createTicket(input, actor)).toThrow(/event insert failed/);

    expect(count(db, "tickets")).toBe(0);
    expect(count(db, "ticket_events")).toBe(0);
  });
});

describe("ticket service checks its own input", () => {
  it.each([
    ["an empty title and description", { title: "", description: "" }],
    ["a title that is short once trimmed", { title: "  ab  ", description: "d" }],
    ["a link that is not http or https", { ...input, where_url: "javascript:alert(1)" }],
    ["a value that is not an object", "Printer is broken"],
    ["nothing at all", undefined],
  ])("rejects %s and writes nothing", (_name, bad) => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");

    expect(() => service.createTicket(bad, actor)).toThrow(ValidationError);

    expect(count(db, "tickets")).toBe(0);
    expect(count(db, "ticket_events")).toBe(0);
  });

  it("says which field is wrong", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    try {
      service.createTicket({ title: "ab", description: "fine" }, actor);
      expect.unreachable("createTicket should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const error = err as ValidationError;
      expect(error.status).toBe(400);
      expect(error.code).toBe("validation_error");
      expect(Object.keys(error.fieldErrors)).toEqual(["title"]);
    }
  });

  it("trims the text, turns an empty check into null and ignores unknown fields", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const ticket = service.createTicket(
      {
        title: "  Printer is broken  ",
        description: "  It jams.  ",
        fix_check: "   ",
        status: "resolved",
        created_by: "someone-else",
        owner_id: "someone-else",
      },
      actor,
    );
    expect(ticket).toMatchObject({
      title: "Printer is broken",
      description: "It jams.",
      where_url: null,
      fix_check: null,
      status: "new",
      created_by: "dev-admin-1",
      owner_id: null,
    });
  });

  it.each([{ status: "done" }, { status: 1 }, {}, "resolved", undefined])(
    "rejects the status change %j and writes nothing",
    (bad) => {
      const { db } = buildTestApp();
      const service = createTicketService(db, "SUP");
      service.createTicket(input, actor);
      const before = service.getTicket("SUP-1", actor);

      expect(() => service.changeStatus("SUP-1", bad, actor)).toThrow(ValidationError);

      expect(service.getTicket("SUP-1", actor)).toEqual(before);
      expect(count(db, "ticket_events")).toBe(1);
    },
  );
});

describe("ticket service actor", () => {
  it("records the actor it is given on the events", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const agent: Actor = {
      id: "helper-1",
      kind: "agent",
      role: "team",
      name: "Helper",
      scopes: ["read_tickets", "write_notes"],
    };
    service.createTicket(input, actor);
    service.addEntry("SUP-1", { kind: "note", body: "Looked at it." }, agent);
    expect(service.listEvents("SUP-1", actor).map((e) => e.actor)).toEqual([
      "dev-admin-1",
      "helper-1",
    ]);
  });

  it("tells a person from an agent that has the same id", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(input, { id: "sam", kind: "person", role: "team", name: "Sam" });
    const note = { kind: "note", body: "x" };
    service.addEntry("SUP-1", note, {
      id: "sam",
      kind: "agent",
      role: "team",
      name: "Sam",
      scopes: ["read_tickets", "write_notes"],
    });
    service.addEntry("SUP-1", note, { id: "sam", kind: "person", role: "team", name: "Sam" });
    expect(service.listEvents("SUP-1", actor).map((e) => [e.actor, e.actor_kind])).toEqual([
      ["sam", "person"],
      ["sam", "agent"],
      ["sam", "person"],
    ]);
  });

  it("cannot store a kind of actor the database does not know", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const robot = { ...actor, kind: "robot" } as unknown as Actor;
    expect(() => service.createTicket(input, robot)).toThrow(/CHECK constraint failed/);
    expect(count(db, "tickets")).toBe(0);
  });
});

describe("ticket events are append-only in the database", () => {
  it("refuses to update or delete an event and leaves it unchanged", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(input, actor);
    const before = service.listEvents("SUP-1", actor);

    expect(() => db.prepare("UPDATE ticket_events SET actor = 'someone-else'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM ticket_events").run()).toThrow(/append-only/);

    expect(service.listEvents("SUP-1", actor)).toEqual(before);
  });
});

describe("ticket service timestamps", () => {
  it("stamps the ticket and each event with the time of the change", () => {
    vi.useFakeTimers();
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const t1 = "2026-01-01T10:00:00.000Z";
    const t2 = "2026-01-01T10:05:00.000Z";
    const t3 = "2026-01-01T10:10:00.000Z";

    vi.setSystemTime(new Date(t1));
    const created = service.createTicket(input, actor);
    expect(created.created_at).toBe(t1);
    expect(created.updated_at).toBe(t1);
    expect(service.listEvents("SUP-1", actor).map((e) => e.created_at)).toEqual([t1]);
    service.takeTicket("SUP-1", actor); // also at t1

    vi.setSystemTime(new Date(t2));
    const changed = service.changeStatus("SUP-1", { status: "in_progress" }, actor);
    expect(changed.created_at).toBe(t1);
    expect(changed.updated_at).toBe(t2);
    expect(service.listEvents("SUP-1", actor).map((e) => e.created_at)).toEqual([t1, t1, t2]);

    // The same status again, later: nothing changes and nothing is logged.
    vi.setSystemTime(new Date(t3));
    const repeated = service.changeStatus("SUP-1", { status: "in_progress" }, actor);
    expect(repeated).toEqual(changed);
    expect(service.getTicket("SUP-1", actor)).toEqual(changed);
    expect(service.listEvents("SUP-1", actor).map((e) => e.created_at)).toEqual([t1, t1, t2]);
  });
});

describe("ticket service returns what is stored", () => {
  it("returns the same ticket from create and change as a later read does", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const created = service.createTicket({ ...input, fix_check: "It prints." }, actor);
    expect(created).toEqual(service.getTicket("SUP-1", actor));
    service.takeTicket("SUP-1", actor);
    const changed = service.changeStatus("SUP-1", { status: "in_progress" }, actor);
    expect(changed).toEqual(service.getTicket("SUP-1", actor));
  });

  it("returns exactly the public fields of a ticket", () => {
    const { db } = buildTestApp();
    db.exec("ALTER TABLE tickets ADD COLUMN private_note TEXT DEFAULT 'secret'");
    const service = createTicketService(db, "SUP");
    const ticket = service.createTicket(input, actor);
    expect(Object.keys(ticket).sort()).toEqual([
      "agent_id",
      "agreed_check",
      "archived_at",
      "ask",
      "change_url",
      "created_at",
      "created_by",
      "customer_answer",
      "description",
      "done_when",
      "fix_check",
      "key",
      "owner_id",
      "owner_name",
      "ready_at",
      "ready_token",
      "resolution",
      "status",
      "title",
      "try_url",
      "updated_at",
      "waiting_on",
      "where_url",
    ]);
  });
});

describe("ticket key prefix is pinned to the database", () => {
  it("accepts the same prefix again and refuses a different one on the same file", () => {
    const { db } = buildTestApp();
    createTicketService(db, "SUP").createTicket(input, actor);

    // The same database with the same prefix, as after a restart.
    expect(createTicketService(db, "SUP").getTicket("SUP-1", actor).title).toBe(input.title);

    expect(() => createTicketService(db, "HELP")).toThrow(
      'TICKET_PREFIX is "HELP" but this database was created with "SUP"',
    );
  });

  it("keeps the pin when the database file is closed and opened again", () => {
    const { db } = buildTestApp();
    createTicketService(db, "SUP");
    const file = path.resolve(db.name);
    db.close();

    const reopened = openDatabase(file);
    try {
      expect(() => createTicketService(reopened, "HELP")).toThrow(/created with "SUP"/);
      expect(() => createTicketService(reopened, "SUP")).not.toThrow();
    } finally {
      reopened.close();
    }
  });
});

describe("a customer's list", () => {
  it("is read through the index on created_by, not by reading every ticket", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    // Catch the SQL the service really uses for a customer's list, then ask SQLite how it
    // would run it.
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      seen.push(sql);
      return prepare(sql);
    });
    service.listTickets("all", customerOne);
    spy.mockRestore();

    const listSql = seen.find((sql) => sql.includes("FROM tickets") && sql.includes("created_by"));
    expect(listSql).toBeDefined();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${listSql}`).all({
      createdBy: customerOne.id,
      status: null,
      limit: 100,
      offset: 0,
      ownerId: null,
      unassigned: 0,
      search: null,
    }) as {
      detail: string;
    }[];
    expect(plan.map((step) => step.detail).join(" | ")).toContain(
      "USING INDEX idx_tickets_created_by",
    );
  });
});

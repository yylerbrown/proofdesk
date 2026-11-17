import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp } from "./helpers.js";

const actor: Actor = { id: "anonymous", kind: "person" };
const input = { title: "Printer is broken", description: "It jams." };

// A trigger that makes every insert into ticket_events fail, to prove the ticket change and
// its event are one transaction.
function breakEventInserts(db: ReturnType<typeof buildTestApp>["db"]) {
  db.exec(
    `CREATE TRIGGER fail_event_insert BEFORE INSERT ON ticket_events
     BEGIN SELECT RAISE(ABORT, 'event insert failed'); END`,
  );
}

describe("ticket service transactions", () => {
  it("rolls back the status change when the event insert fails", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(input, actor);

    breakEventInserts(db);
    expect(() => service.changeStatus("SUP-1", "resolved", actor)).toThrow(/event insert failed/);

    expect(service.getTicket("SUP-1").status).toBe("new");
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 1 });
  });

  it("rolls back the new ticket when the creation event fails", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");

    breakEventInserts(db);
    expect(() => service.createTicket(input, actor)).toThrow(/event insert failed/);

    expect(db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  });
});

describe("ticket service actor", () => {
  it("records the actor it is given on the events", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    const agent: Actor = { id: "helper-1", kind: "agent" };
    service.createTicket(input, agent);
    service.changeStatus("SUP-1", "resolved", actor);
    expect(service.listEvents("SUP-1").map((e) => e.actor)).toEqual(["helper-1", "anonymous"]);
  });
});

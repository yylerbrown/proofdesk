import { describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.js";
import { parseKey } from "../src/server/tickets/keys.js";
import { latestAnswer, ownerOf } from "../src/server/tickets/repository.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, customerOne } from "./helpers.js";

// The customer's latest answer to "Did this fix it?", read from history written before the
// history kept a No's comment: the comment is then the reply written at the same moment.

const AT = "2026-01-05T10:00:00.000Z";

function setUp() {
  const { db, config } = buildTestApp();
  const tickets = createTicketService(db, config.ticketPrefix);
  const { key } = tickets.createTicket(
    { title: "Printer jams", description: "It jams on page two.", fix_check: "Ten pages print" },
    customerOne,
  );
  return { db, id: parseKey(config.ticketPrefix, key)! };
}

function answered(db: Db, id: number, data: object, actor = customerOne.id) {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, actor, type, data, created_at)
     VALUES (?, ?, 'customer_answered', ?, ?)`,
  ).run(id, actor, JSON.stringify(data), AT);
}

function replied(db: Db, id: number, body: string, createdAt = AT) {
  db.prepare(
    `INSERT INTO ticket_entries
       (ticket_id, kind, body, author, author_kind, author_role, author_name, created_at)
     VALUES (?, 'reply', ?, ?, 'person', 'customer', ?, ?)`,
  ).run(id, body, customerOne.id, customerOne.name, createdAt);
}

describe("the latest answer, from old history", () => {
  it("finds a No's comment in the reply written at the same moment", () => {
    const { db, id } = setUp();
    answered(db, id, { fixed: false });
    replied(db, id, "It still jams on page two.");
    expect(latestAnswer(db, id)).toEqual({
      fixed: false,
      at: AT,
      comment: "It still jams on page two.",
    });
  });

  it("has no comment when no reply was written at that moment", () => {
    const { db, id } = setUp();
    answered(db, id, { fixed: false });
    replied(db, id, "A reply from another day.", "2026-01-04T10:00:00.000Z");
    expect(latestAnswer(db, id)?.comment).toBeNull();
  });

  it("keeps the comment the history holds, and looks for none on a Yes", () => {
    const { db, id } = setUp();
    replied(db, id, "A reply at the same moment.");
    answered(db, id, { fixed: false, comment: "Still jams." });
    expect(latestAnswer(db, id)?.comment).toBe("Still jams.");
    answered(db, id, { fixed: true });
    expect(latestAnswer(db, id)).toEqual({ fixed: true, at: AT, comment: null });
  });
});

describe("the owner of a ticket", () => {
  it("is null for a ticket id with no row", () => {
    const { db, id } = setUp();
    expect(ownerOf(db, id + 1000)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/server/errors.js";
import { requireVersion, saved } from "../src/server/tickets/checks.js";
import * as repository from "../src/server/tickets/repository.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne } from "./helpers.js";

// The retry-safe wrapper around a write, and the version check beside it, at their edges: an
// idempotency key that is empty or too long, an answer that names no ticket, and a row whose
// version the database does not give.

const valid = { title: "Export fails", description: "The export button does nothing." };

function service() {
  const { db, config } = buildTestApp();
  return { db, tickets: createTicketService(db, config.ticketPrefix) };
}

describe("an idempotency key outside 1 to 100 characters", () => {
  it.each([
    ["empty", ""],
    ["101 characters", "k".repeat(101)],
  ])("is refused when it is %s, and the write does not run", (_name, key) => {
    const { db, tickets } = service();
    let ran = 0;
    let thrown: unknown;
    try {
      tickets.once(customerOne, key, "add_note", "SUP-1", {}, () => ++ran);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).fieldErrors).toHaveProperty("idempotency_key");
    expect(ran).toBe(0);
    const kept = db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get() as { n: number };
    expect(kept.n).toBe(0);
  });

  it("is kept at exactly 100 characters, and the retry gets the first answer", () => {
    const { tickets } = service();
    const key = "k".repeat(100);
    let ran = 0;
    const first = tickets.once(customerOne, key, "add_note", "SUP-1", { a: 1 }, () => ({
      n: ++ran,
    }));
    const again = tickets.once(customerOne, key, "add_note", "SUP-1", { a: 1 }, () => ({
      n: ++ran,
    }));
    expect(first).toEqual({ n: 1 });
    expect(again).toEqual({ n: 1 });
    expect(ran).toBe(1);
  });

  it("is refused with 400 through the API, and no ticket is filed", async () => {
    const { app, db } = buildTestApp();
    const res = await as(app, customerOne)
      .post("/api/tickets")
      .set("Idempotency-Key", "k".repeat(101))
      .send(valid);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("idempotency_key");
    const filed = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number };
    expect(filed.n).toBe(0);
  });
});

describe("a kept answer that names no ticket", () => {
  it.each([
    ["no key", { done: true }],
    ["a key that is not text", { key: 7 }],
    ["no answer at all", null],
  ])("is tied to no ticket when the answer has %s", (_name, answer) => {
    const { db, tickets } = service();
    tickets.once(customerOne, "loose-1", "create", "", {}, () => answer);
    const row = db
      .prepare("SELECT ticket_id FROM idempotency_keys WHERE key = 'loose-1'")
      .get() as { ticket_id: number | null };
    expect(row.ticket_id).toBeNull();
  });

  it("is tied to the ticket its answer names when the request named none", () => {
    const { db, tickets } = service();
    tickets.once(customerOne, "file-1", "create", "", {}, () => ({ key: "SUP-4" }));
    const row = db.prepare("SELECT ticket_id FROM idempotency_keys WHERE key = 'file-1'").get() as {
      ticket_id: number | null;
    };
    expect(row.ticket_id).toBe(4);
  });
});

describe("the version check", () => {
  it("lets a caller that sends no version through, and one that sends the right one", () => {
    const { db, tickets } = service();
    const filed = tickets.createTicket(valid, customerOne);
    const row = repository.findTicket(db, 1)!;
    expect(() => requireVersion(filed.key, row)).not.toThrow();
    expect(() => requireVersion(filed.key, row, row.version)).not.toThrow();
    expect(() => requireVersion(filed.key, row, row.version + 1)).toThrow(
      expect.objectContaining({ status: 409, code: "ticket_changed" }),
    );
  });

  it("keeps the row's own version when the database gives none", () => {
    const { db, tickets } = service();
    tickets.createTicket(valid, customerOne);
    const row = repository.findTicket(db, 1)!;
    // A row that is no longer in the table has no version to read back.
    const gone = { ...row, id: 999, version: 41 };
    expect(saved(db, gone).version).toBe(41);
  });

  it("takes the database's version when it has one", () => {
    const { db, tickets } = service();
    tickets.createTicket(valid, customerOne);
    const row = repository.findTicket(db, 1)!;
    expect(saved(db, { ...row, version: -5 }).version).toBe(row.version);
  });
});

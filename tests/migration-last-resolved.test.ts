import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/server/db.js";
import { defaultMigrationsDir, runMigrations } from "../src/server/migrate.js";

// Migration 0037 records when each resolved ticket last became Resolved. For the tickets already
// in a database it reads that from their history, and falls back to when they were last updated.

const LAST = "0037_ticket_last_resolved.sql";
const opened: { db: Db; dir: string }[] = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A database with every migration before 0037, and a folder holding those migrations. */
function beforeLast() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-migration-"));
  for (const name of fs.readdirSync(defaultMigrationsDir)) {
    if (name.endsWith(".sql") && name < LAST) {
      fs.copyFileSync(path.join(defaultMigrationsDir, name), path.join(dir, name));
    }
  }
  const db = openDatabase(":memory:");
  opened.push({ db, dir });
  runMigrations(db, dir);
  return { db, dir };
}

function addTicket(db: Db, id: number, status: string, updatedAt: string) {
  db.prepare(
    `INSERT INTO tickets (id, title, description, status, created_by, created_at, updated_at)
     VALUES (?, ?, 'x', ?, 'someone', '2026-01-01T00:00:00.000Z', ?)`,
  ).run(id, `Ticket ${id}`, status, updatedAt);
}

function addEvent(db: Db, ticketId: number, type: string, data: object, at: string) {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, actor, type, data, created_at)
     VALUES (?, 'someone', ?, ?, ?)`,
  ).run(ticketId, type, JSON.stringify(data), at);
}

describe("migration 0037", () => {
  it("fills in when each resolved ticket last became Resolved", () => {
    const { db, dir } = beforeLast();
    // Resolved by a status change, reopened, then resolved by the team: the last one counts.
    addTicket(db, 1, "resolved", "2026-03-09T00:00:00.000Z");
    addEvent(db, 1, "status_changed", { from: "new", to: "resolved" }, "2026-02-01T00:00:00.000Z");
    addEvent(db, 1, "reopened", {}, "2026-02-05T00:00:00.000Z");
    addEvent(db, 1, "resolved_by_team", {}, "2026-03-01T00:00:00.000Z");
    // Resolved by the customer's Yes.
    addTicket(db, 2, "resolved", "2026-04-09T00:00:00.000Z");
    addEvent(db, 2, "customer_answered", { fixed: true }, "2026-04-01T00:00:00.000Z");
    // No history that says: when it was last updated.
    addTicket(db, 3, "resolved", "2026-05-01T00:00:00.000Z");
    // Open: no time.
    addTicket(db, 4, "in_progress", "2026-06-01T00:00:00.000Z");

    fs.copyFileSync(path.join(defaultMigrationsDir, LAST), path.join(dir, LAST));
    expect(runMigrations(db, dir)).toEqual([LAST]);

    const rows = db.prepare("SELECT id, last_resolved_at FROM tickets ORDER BY id").all();
    expect(rows).toEqual([
      { id: 1, last_resolved_at: "2026-03-01T00:00:00.000Z" },
      { id: 2, last_resolved_at: "2026-04-01T00:00:00.000Z" },
      { id: 3, last_resolved_at: "2026-05-01T00:00:00.000Z" },
      { id: 4, last_resolved_at: null },
    ]);
  });
});

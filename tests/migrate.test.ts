import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDatabaseOk, openDatabase, type Db } from "../src/server/db.js";
import { defaultMigrationsDir, runMigrations } from "../src/server/migrate.js";
import { createTicketService } from "../src/server/tickets/service.js";

const tempDirs: string[] = [];
const dbs: Db[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-"));
  tempDirs.push(dir);
  return dir;
}

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Every migration in the migrations folder, in the order it is applied.
const ALL = [
  "0001_app_meta.sql",
  "0002_tickets.sql",
  "0003_event_actor_kind.sql",
  "0004_events_append_only.sql",
  "0005_ticket_archive.sql",
  "0006_sign_in_tables.sql",
  "0007_tickets_created_by_index.sql",
  "0008_permanent_delete.sql",
  "0009_ticket_entries.sql",
  "0010_ticket_owner.sql",
  "0011_agreed_check.sql",
  "0012_confirmation.sql",
  "0013_ready_token.sql",
  "0014_agent_connections.sql",
  "0015_ticket_evidence.sql",
  "0016_idempotency_keys.sql",
  "0017_agent_activity.sql",
  "0018_ticket_specs.sql",
  "0019_ask_record.sql",
  "0020_agent_handoffs.sql",
  "0021_reply_source.sql",
  "0022_blocked_notes.sql",
  "0023_note_purpose.sql",
  "0024_team_resolution.sql",
  "0025_agent_activity_created_index.sql",
  "0026_email_outbox.sql",
  "0027_email_retry_time.sql",
  "0028_people_roles.sql",
  "0029_email_setting.sql",
  "0030_ticket_version.sql",
  "0031_connection_end_reason.sql",
  "0032_ticket_list_order_indexes.sql",
  "0033_github_account_index.sql",
  "0034_ticket_list_sort_indexes.sql",
  "0035_ticket_search.sql",
  "0036_ticket_pictures.sql",
  "0037_ticket_last_resolved.sql",
  "0038_check_suggestions.sql",
];

describe("runMigrations", () => {
  it("applies the bundled migrations once and records them", () => {
    const db = memoryDb();
    const first = runMigrations(db);
    expect(first).toEqual(ALL);
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run("k", "v");
    const rows = db.prepare("SELECT name FROM schema_migrations").all();
    expect(rows).toEqual(ALL.map((name) => ({ name })));
  });

  it("is idempotent on a second run", () => {
    const db = memoryDb();
    runMigrations(db);
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run("k", "v");
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({
      n: ALL.length,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM app_meta").get()).toEqual({ n: 1 });
  });

  it("applies files in numeric order and only new ones later", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
    fs.writeFileSync(path.join(dir, "0001_a.sql"), "CREATE TABLE a (id INTEGER);");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
    const db = memoryDb();
    expect(runMigrations(db, dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
    fs.writeFileSync(path.join(dir, "0003_c.sql"), "CREATE TABLE c (id INTEGER);");
    expect(runMigrations(db, dir)).toEqual(["0003_c.sql"]);
  });

  it("skips a file that another server applied in the meantime, instead of failing", () => {
    const dir = tempDir();
    // The first file also does what a second server would have done at the same moment:
    // it creates the table of the second file and records that file as applied.
    fs.writeFileSync(
      path.join(dir, "0001_a.sql"),
      `CREATE TABLE a (id INTEGER);
       CREATE TABLE b (id INTEGER);
       INSERT INTO schema_migrations (name) VALUES ('0002_b.sql');`,
    );
    fs.writeFileSync(path.join(dir, "0002_b.sql"), "CREATE TABLE b (id INTEGER);");
    const db = memoryDb();
    expect(runMigrations(db, dir)).toEqual(["0001_a.sql"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 2 });
  });

  it("rolls back a migration that leaves rows pointing at nothing", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "0001_a.sql"),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (parent_id INTEGER REFERENCES parent (id));
       INSERT INTO child (parent_id) VALUES (7);`,
    );
    const db = memoryDb();
    expect(() => runMigrations(db, dir)).toThrow(
      /0001_a.sql leaves rows that point at missing rows/,
    );
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'child'").get()).toBeUndefined();
    // The checks are back on afterwards.
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("keeps the event log pointing at tickets after the tickets table is rebuilt", () => {
    const db = memoryDb();
    runMigrations(db);
    const insertEvent = db.prepare(
      `INSERT INTO ticket_events (ticket_id, actor, type, data, created_at)
       VALUES (?, 'x', 'created', '{}', 'now')`,
    );
    expect(() => insertEvent.run(99)).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("puts the tickets already there into the word index, archived ones too", () => {
    // A database from before the word index, holding two tickets, one of them archived.
    const dir = tempDir();
    const before = ALL.filter((name) => name !== "0035_ticket_search.sql");
    for (const name of before) {
      fs.copyFileSync(path.join(defaultMigrationsDir, name), path.join(dir, name));
    }
    const db = memoryDb();
    runMigrations(db, dir);
    const service = createTicketService(db, "SUP");
    const customer = { id: "c-1", kind: "person" as const, role: "customer" as const, name: "C" };
    service.createTicket({ title: "Cannot sign in on my phone", description: "x" }, customer);
    service.createTicket({ title: "Printer jams", description: "On page two" }, customer);
    db.prepare("UPDATE tickets SET archived_at = 'now' WHERE id = 2").run();

    fs.copyFileSync(
      path.join(defaultMigrationsDir, "0035_ticket_search.sql"),
      path.join(dir, "0035_ticket_search.sql"),
    );
    expect(runMigrations(db, dir)).toEqual(["0035_ticket_search.sql"]);
    const found = (match: string) =>
      db.prepare("SELECT rowid FROM ticket_search WHERE ticket_search MATCH ?").all(match);
    expect(found('"signing" AND "phone"')).toEqual([{ rowid: 1 }]);
    expect(found('"page" AND "printer"')).toEqual([{ rowid: 2 }]);
  });

  it("rolls back a failing migration and does not record it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "0001_bad.sql"), "CREATE TABLE t (id INTEGER); NOT SQL;");
    const db = memoryDb();
    expect(() => runMigrations(db, dir)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't'").get(),
    ).toBeUndefined();
  });
});

describe("database", () => {
  it("opens a file database, creating its directory", () => {
    const file = path.join(tempDir(), "nested", "app.db");
    const db = openDatabase(file);
    dbs.push(db);
    expect(isDatabaseOk(db)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isDatabaseOk, openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";

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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";
import { checkDatabasePurpose } from "../src/server/purpose.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor } from "./helpers.js";

const dirs: string[] = [];
const dbs: Db[] = [];

/** A fresh, migrated database file. */
function freshDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-purpose-"));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, "app.db"));
  dbs.push(db);
  runMigrations(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A database used for real tickets, with a ticket and an internal note in it. */
function realDbWithTickets(): Db {
  const db = freshDb();
  createApp(loadConfig({ DEV_SIGN_IN: "on" }), db);
  const service = createTicketService(db, "SUP");
  service.createTicket({ title: "Real customer problem", description: "Private." }, adminActor);
  service.addEntry("SUP-1", { kind: "note", body: "Internal only" }, adminActor);
  return db;
}

function snapshot(db: Db) {
  return JSON.stringify([
    db.prepare("SELECT * FROM tickets").all(),
    db.prepare("SELECT * FROM ticket_entries").all(),
    db.prepare("SELECT * FROM ticket_events").all(),
    db.prepare("SELECT * FROM app_meta ORDER BY key").all(),
  ]);
}

describe("the purpose of a database", () => {
  it("is recorded on first start: real for a normal server, demo for the demo", () => {
    const real = freshDb();
    createApp(loadConfig({ DEV_SIGN_IN: "on" }), real);
    expect(real.prepare("SELECT value FROM app_meta WHERE key = 'purpose'").get()).toEqual({
      value: "real",
    });
    const demo = freshDb();
    createApp(loadConfig({ DEMO: "on" }), demo);
    expect(demo.prepare("SELECT value FROM app_meta WHERE key = 'purpose'").get()).toEqual({
      value: "demo",
    });
  });

  it("stops a demo server on a real database before it changes anything", () => {
    const db = realDbWithTickets();
    const before = snapshot(db);
    expect(() => createApp(loadConfig({ DEMO: "on" }), db)).toThrow(
      /This database is for the real tickets, but the server was started as the demo/,
    );
    expect(snapshot(db)).toBe(before);
  });

  it("stops a real server on the demo's database", () => {
    const db = freshDb();
    createApp(loadConfig({ DEMO: "on" }), db);
    expect(() => createApp(loadConfig({ DEV_SIGN_IN: "on" }), db)).toThrow(
      /This database is for the demo, but the server was started for real tickets/,
    );
  });

  it("never labels an existing database that holds data as a demo", () => {
    // A database from before purposes were recorded, already holding a ticket.
    const db = freshDb();
    createTicketService(db, "SUP").createTicket(
      { title: "Old ticket", description: "x" },
      adminActor,
    );
    const before = snapshot(db);
    expect(() => checkDatabasePurpose(db, true)).toThrow(/already holds data/);
    expect(snapshot(db)).toBe(before);
    // Started for real tickets, it is labelled real.
    checkDatabasePurpose(db, false);
    expect(db.prepare("SELECT value FROM app_meta WHERE key = 'purpose'").get()).toEqual({
      value: "real",
    });
  });
});

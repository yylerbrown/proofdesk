import type { Express } from "express";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { seedDemo } from "./demo.js";
import type { LogLine } from "./http-basics.js";
import { runMigrations } from "./migrate.js";
import { checkPurposeBeforeMigrating } from "./purpose.js";
import { createTicketService } from "./tickets/service.js";

/**
 * Opens the database and brings it up to date, in a safe order: a database labelled for the
 * other purpose (demo or real) is refused before any migration can change it.
 */
export function openAndMigrate(config: Config): { db: Db; applied: string[] } {
  const db = openDatabase(config.databasePath);
  try {
    checkPurposeBeforeMigrating(db, config.demo);
  } catch (err) {
    db.close();
    throw err;
  }
  return { db, applied: runMigrations(db) };
}

/** The app that answers requests, and the database it reads and writes. */
export type Site = { app: Express; db: Db };

/**
 * Opens the database, builds the app on it and, on the demo, seeds its samples when the
 * database is empty. If anything fails, the database is closed again before the error goes on.
 * The demo's own reset passes false for sayMigrations, so a reset writes one line, not two.
 */
export function openSite(config: Config, log: LogLine, sayMigrations = true): Site {
  // A database labelled for the other purpose is refused before any migration touches it.
  const { db, applied } = openAndMigrate(config);
  try {
    if (sayMigrations && applied.length > 0) log(`Applied migrations: ${applied.join(", ")}`);
    // With GitHub sign-in and no admin in the settings, nobody can choose who is on the team.
    if (config.signIn !== null && config.adminGithubIds.length === 0) {
      console.warn(
        "No admin is named in ADMIN_GITHUB_IDS. " +
          "Set it to at least one GitHub user number, so the site always has an admin.",
      );
    }
    // createApp checks the database's purpose first, so the demo is only seeded into a demo
    // database. It logs one line per request.
    const app = createApp(config, db, { log });
    if (config.demo) {
      const service = createTicketService(db, config.ticketPrefix);
      seedDemo(service);
      // A database filled by older code has no record of its samples, and assistant
      // connections stay off until it is reset. Say so where an operator looks first.
      if (!service.hasDemoSeed()) {
        console.warn(
          "This demo's database was filled before its samples were recorded, so assistant " +
            "connections are off. Reset it: docs/DEPLOY.md, Resetting the demo.",
        );
      }
    }
    return { app, db };
  } catch (err) {
    db.close();
    throw err;
  }
}

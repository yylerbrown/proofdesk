import type { Express } from "express";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { seedDemo } from "./demo.js";
import type { LogLine } from "./http-basics.js";
import { runMigrations } from "./migrate.js";
import { endConnectionsOfFormerAdmins, forgetRolesNamedInSettings } from "./people/service.js";
import { checkPurposeBeforeMigrating } from "./purpose.js";
import { createTicketService } from "./tickets/service.js";

/**
 * Opens the database and brings it up to date, in a safe order: a database labelled for the
 * other purpose (demo or real) is refused before any migration can change it. If the check or
 * a migration fails, the database is closed again before the error goes on.
 */
export function openAndMigrate(config: Config): { db: Db; applied: string[] } {
  const db = openDatabase(config.databasePath);
  try {
    checkPurposeBeforeMigrating(db, config.demo);
    return { db, applied: runMigrations(db) };
  } catch (err) {
    db.close();
    throw err;
  }
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
    // A role chosen on the People page for someone the settings now name is forgotten, so it
    // cannot come back when the settings stop naming them.
    forgetRolesNamedInSettings(db, config);
    // A connection whose issuer is no longer an admin is refused when it signs in. Ending it
    // here, with its reason, keeps the Connections page and the hand-off list saying the same.
    // The operator's log says how many it ended, so a connection that stopped has a reason there.
    const ended = endConnectionsOfFormerAdmins(db, config);
    const noun = ended === 1 ? "connection" : "connections";
    if (ended > 0) log(`Ended ${ended} assistant ${noun} whose issuer is no longer an admin.`);
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

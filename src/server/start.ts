import type { Config } from "./config.js";
import { openDatabase, type Db } from "./db.js";
import { runMigrations } from "./migrate.js";
import { checkPurposeBeforeMigrating } from "./purpose.js";

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

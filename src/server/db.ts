import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type Db = Database.Database;

/** Opens the SQLite database, creating its parent directory if needed. Use ":memory:" for tests. */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/** True when the database answers a trivial query. */
export function isDatabaseOk(db: Db): boolean {
  try {
    return db.prepare("SELECT 1 AS ok").get() !== undefined;
  } catch {
    return false;
  }
}

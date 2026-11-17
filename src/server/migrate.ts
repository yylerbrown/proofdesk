import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";

export const defaultMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

const FILE_PATTERN = /^(\d+)_[a-z0-9_]+\.sql$/;

/**
 * Applies numbered .sql files (for example 0001_init.sql) in order and records each in the
 * schema_migrations table. Returns the names applied by this run.
 */
export function runMigrations(db: Db, dir: string = defaultMigrationsDir): string[] {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );

  const files = fs
    .readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .sort((a, b) => Number(a.match(FILE_PATTERN)![1]) - Number(b.match(FILE_PATTERN)![1]));

  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?");
  const record = db.prepare("INSERT INTO schema_migrations (name) VALUES (?)");

  // Checks whether the file was applied and applies it, as one step. Returns true when it
  // applied it.
  const applyOnce = db.transaction((file: string): boolean => {
    if (isApplied.get(file) !== undefined) return false;
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    record.run(file);
    return true;
  });

  const newlyApplied: string[] = [];
  for (const file of files) {
    // "immediate" takes the write lock before the check. A second server starting at the
    // same moment waits here, then finds the file applied and skips it. Without it both
    // could pass the check and the slower one would fail on a table that already exists.
    if (applyOnce.immediate(file)) newlyApplied.push(file);
  }
  return newlyApplied;
}

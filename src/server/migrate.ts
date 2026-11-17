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

  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const record = db.prepare("INSERT INTO schema_migrations (name) VALUES (?)");
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    })();
    newlyApplied.push(file);
  }
  return newlyApplied;
}

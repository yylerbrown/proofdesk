import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";

const opened: { db: Db; dir: string }[] = [];

/** Builds an app on a fresh database file in a temp directory. Cleaned up after each test. */
export function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-test-"));
  const db = openDatabase(path.join(dir, "test.db"));
  opened.push({ db, dir });
  runMigrations(db);
  const config = loadConfig(env);
  return { app: createApp(config, db), db, config };
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

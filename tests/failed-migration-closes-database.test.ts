import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/server/db.js";

// When a migration fails at start-up, the database handle is closed before the error goes on,
// as it is when the database's purpose is refused.

const opened: Db[] = [];

vi.mock("../src/server/db.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server/db.js")>();
  return {
    ...real,
    openDatabase: (file: string) => {
      const db = real.openDatabase(file);
      opened.push(db);
      return db;
    },
  };
});

vi.mock("../src/server/migrate.js", () => ({
  runMigrations: () => {
    throw new Error("A migration failed.");
  },
}));

describe("a failed migration at start-up", () => {
  it("closes the database and passes the error on", async () => {
    const { loadConfig } = await import("../src/server/config.js");
    const { openAndMigrate } = await import("../src/server/start.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-test-"));
    const config = loadConfig({ DEV_SIGN_IN: "on", DATABASE_PATH: path.join(dir, "test.db") });
    try {
      expect(() => openAndMigrate(config)).toThrow("A migration failed.");
      expect(opened).toHaveLength(1);
      expect(opened[0]!.open).toBe(false);
    } finally {
      for (const db of opened) if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

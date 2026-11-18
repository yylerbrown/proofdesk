import type { Db } from "./db.js";
import { getMeta, insertMeta } from "./tickets/repository.js";

const PURPOSE_KEY = "purpose";

/**
 * Every database is for one purpose: the public demo, or real tickets. The first start writes
 * the purpose into the database, and every later start must agree, so a demo server can never
 * be pointed at real tickets, nor a real server at the demo's sample data.
 *
 * An existing database that already holds data is never labelled as a demo: it may hold real
 * tickets. Run this after the migrations and before anything else touches the data.
 */
export function checkDatabasePurpose(db: Db, demo: boolean): void {
  const wanted = demo ? "demo" : "real";
  const stored = getMeta(db, PURPOSE_KEY);
  if (stored === undefined) {
    if (demo && !isEmpty(db)) {
      throw new Error(
        "Refusing to start the demo on a database that already holds data. " +
          "Give the demo its own, new database file.",
      );
    }
    insertMeta(db, PURPOSE_KEY, wanted);
    return;
  }
  if (stored !== wanted) {
    throw new Error(
      `This database is for the ${stored === "demo" ? "demo" : "real tickets"}, but the server ` +
        `was started ${demo ? "as the demo" : "for real tickets"}. Check DEMO and DATABASE_PATH.`,
    );
  }
}

/**
 * The same refusal, before any migration runs: a database already labelled for the other
 * purpose is refused untouched, so a demo server pointed at the real file cannot change it
 * first. A database with no label yet (a new file, or one from before labels) passes here and
 * gets its label from checkDatabasePurpose after the migrations.
 */
export function checkPurposeBeforeMigrating(db: Db, demo: boolean): void {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'")
    .get();
  if (hasMeta === undefined) return;
  const stored = getMeta(db, PURPOSE_KEY);
  if (stored === undefined) return;
  checkDatabasePurpose(db, demo);
}

/** True when no ticket, deleted ticket or signed-in person has ever been stored. */
function isEmpty(db: Db): boolean {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return (
    count("SELECT COUNT(*) AS n FROM tickets") === 0 &&
    count("SELECT COUNT(*) AS n FROM deleted_tickets") === 0 &&
    count('SELECT COUNT(*) AS n FROM "user"') === 0
  );
}

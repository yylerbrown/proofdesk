import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/server/db.js";
import { createNotifier } from "../src/server/notify/notifier.js";
import { buildTestApp } from "./helpers.js";

// What the notifier writes to the server's log when it starts and when something goes wrong,
// and that it does nothing once the database is closed. Nothing here touches the network.

const MAIL_ENV = {
  SMTP_URL: "smtp://notices:secret@mail.example.com:2525",
  MAIL_FROM: "notices@example.com",
};

/** A transport that sends nothing anywhere. */
function quiet(): Transporter {
  return nodemailer.createTransport({
    name: "quiet",
    version: "1",
    send: (_mail, done) => done(null, { messageId: "x" } as never),
  }) as Transporter;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A database with no tables at all, so every read the notifier makes fails. */
function emptyDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-notifier-"));
  dirs.push(dir);
  return openDatabase(path.join(dir, "empty.db"));
}

describe("the notifier's log lines", () => {
  it("says notices are kept, not sent, when no mail server is set", () => {
    const { config, db } = buildTestApp();
    const lines: string[] = [];
    const notifier = createNotifier({ config, currentDb: () => db, log: (l) => lines.push(l) });
    notifier.start();
    notifier.stop();
    expect(lines).toEqual(["Email notices are kept, not sent: no mail server is set."]);
  });

  it("says nothing on start on the demo", () => {
    const { config, db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const lines: string[] = [];
    const notifier = createNotifier({ config, currentDb: () => db, log: (l) => lines.push(l) });
    notifier.start();
    notifier.stop();
    expect(lines).toEqual([]);
  });

  it("says the notices could not be collected when the database cannot be read", async () => {
    const { config } = buildTestApp();
    const db = emptyDb();
    const lines: string[] = [];
    const notifier = createNotifier({ config, currentDb: () => db, log: (l) => lines.push(l) });
    await notifier.run();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Notices could not be collected: /);
    db.close();
  });

  it("names only the kind of error when sending stops", async () => {
    const { config } = buildTestApp(MAIL_ENV);
    const db = emptyDb();
    const lines: string[] = [];
    const notifier = createNotifier({
      config,
      currentDb: () => db,
      log: (l) => lines.push(l),
      transport: quiet(),
    });
    await notifier.run();
    expect(lines).toContain("Email notices stopped with an error: SqliteError.");
    // The error's own words, which could name a table, are not logged when sending stops.
    expect(lines.filter((l) => l.startsWith("Email notices stopped"))).toHaveLength(1);
    db.close();
  });
});

describe("a closed database", () => {
  it("is neither read nor sent from, and nothing is logged", async () => {
    const { config, db } = buildTestApp(MAIL_ENV);
    const lines: string[] = [];
    let handed = 0;
    const transport = nodemailer.createTransport({
      name: "counts",
      version: "1",
      send: (_mail, done) => {
        handed += 1;
        done(null, { messageId: "x" } as never);
      },
    }) as Transporter;
    const notifier = createNotifier({
      config,
      currentDb: () => db,
      log: (l) => lines.push(l),
      transport,
    });
    db.close();
    await notifier.run();
    expect(lines).toEqual([]);
    expect(handed).toBe(0);
  });
});

import nodemailer, { type Transporter } from "nodemailer";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.js";
import { MOST_ATTEMPTS, plainReason, sendDueNotices } from "../src/server/notify/send.js";
import { as, buildTestApp, customerOne } from "./helpers.js";
import { ok } from "./notify-life.js";

// Sending email notices at the edges the main tests do not reach: a notice whose last try was
// cut off, an address that is not an email address, a database closed before the first send,
// and the plain reasons kept for errors with little in them. Nothing here touches the network.

const MAIL_ENV = {
  SMTP_URL: "smtp://notices:secret@mail.example.com:2525",
  MAIL_FROM: "notices@example.com",
};
const SEND_SETTINGS = { from: MAIL_ENV.MAIL_FROM, ticketPrefix: "SUP" };

/** A transport that counts the mails handed to it and sends none of them anywhere. */
function counting(): { transport: Transporter; sent: () => number } {
  let sent = 0;
  const transport = nodemailer.createTransport({
    name: "counts",
    version: "1",
    send: (_mail, done) => {
      sent += 1;
      done(null, { messageId: "x" } as never);
    },
  });
  return { transport: transport as Transporter, sent: () => sent };
}

type Row = { state: string; attempts: number; last_error: string | null };

/** A test app with one ticket and one pending notice to this address, tried this many times. */
async function oneNotice(address: string, attempts = 0): Promise<Db> {
  const { app, db } = buildTestApp(MAIL_ENV);
  await ok(
    as(app, customerOne).post("/api/tickets").send({ title: "Printer jams", description: "x" }),
    201,
  );
  db.prepare(
    `INSERT INTO email_outbox (event_id, ticket_id, recipient_id, kind, address, subject, body,
       state, attempts, created_at, updated_at)
     VALUES (1, 1, 'dev-customer-1', 'team_replied', ?, 'Subject', 'Body', 'pending', ?,
       'now', 'now')`,
  ).run(address, attempts);
  return db;
}

function row(db: Db): Row {
  return db.prepare("SELECT state, attempts, last_error FROM email_outbox").get() as Row;
}

describe("a notice that cannot be sent", () => {
  it("is failed without a send when its last try was cut off", async () => {
    const db = await oneNotice("dev-customer-1@example.com", MOST_ATTEMPTS);
    const { transport, sent } = counting();
    const result = await sendDueNotices(db, transport, SEND_SETTINGS);
    expect(sent()).toBe(0);
    // The cut-off try is not counted again, and the call reports no send of its own.
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(row(db)).toMatchObject({ state: "failed", attempts: MOST_ATTEMPTS });
    expect(row(db).last_error).toMatch(/cut off/);
  });

  it("is sent on its last allowed try", async () => {
    const db = await oneNotice("dev-customer-1@example.com", MOST_ATTEMPTS - 1);
    const { transport, sent } = counting();
    expect(await sendDueNotices(db, transport, SEND_SETTINGS)).toEqual({ sent: 1, failed: 0 });
    expect(sent()).toBe(1);
    expect(row(db).state).toBe("sent");
  });

  it.each(["not an address", "two@@example.com", "nobody@"])(
    "is failed without a send when its address is %j",
    async (address) => {
      const db = await oneNotice(address);
      const { transport, sent } = counting();
      expect(await sendDueNotices(db, transport, SEND_SETTINGS)).toEqual({ sent: 0, failed: 1 });
      expect(sent()).toBe(0);
      expect(row(db).state).toBe("failed");
      expect(row(db).last_error).toMatch(/not a valid email address/);
    },
  );
});

describe("a database closed before sending", () => {
  it("sends nothing and keeps the notice's tries", async () => {
    const db = await oneNotice("dev-customer-1@example.com");
    const { transport, sent } = counting();
    db.close();
    expect(await sendDueNotices(db, transport, SEND_SETTINGS)).toEqual({ sent: 0, failed: 0 });
    expect(sent()).toBe(0);
  });
});

describe("the plain reason kept for a failed try", () => {
  it.each<[string, unknown, string]>([
    ["nothing at all", undefined, "The mail could not be sent."],
    ["a plain text", "boom", "The mail could not be sent."],
    [
      "only an answer number",
      { responseCode: 421 },
      "The mail could not be sent. It answered 421.",
    ],
    [
      "a known code and an answer number",
      { code: "EENVELOPE", responseCode: 550 },
      "The mail server refused the address. It answered 550.",
    ],
    [
      "an answer number out of range",
      { code: "ETIMEDOUT", responseCode: 99 },
      "The mail server took too long to answer.",
    ],
  ])("for %s", (_name, err, reason) => {
    expect(plainReason(err)).toBe(reason);
  });
});

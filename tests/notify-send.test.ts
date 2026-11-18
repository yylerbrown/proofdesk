import nodemailer, { type SendMailOptions, type Transporter } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../src/server/db.js";
import { createNotifier } from "../src/server/notify/notifier.js";
import { NOT_SENT_REASONS } from "../src/server/notify/outbox.js";
import { claimNotice } from "../src/server/notify/repository.js";
import { saveEmailMe } from "../src/server/people/repository.js";
import {
  CLAIM_LEASE_MS,
  MOST_ATTEMPTS,
  plainReason,
  RETRY_WAITS_MS,
  SEND_BATCH,
  sendDueNotices,
} from "../src/server/notify/send.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";
import { fullLife, giveAddresses, NOTE_MARKER, ok } from "./notify-life.js";

// Sending email notices, always through nodemailer's own test transports: nothing here touches
// the network. The mail server's address carries a password, which must never show anywhere.

const PASSWORD = "pw-NEVER-SHOWN-4417";
const MAIL_ENV = {
  SMTP_URL: `smtp://notices:${PASSWORD}@mail.example.com:2525`,
  MAIL_FROM: "notices@example.com",
};
const SEND_SETTINGS = { from: MAIL_ENV.MAIL_FROM, ticketPrefix: "SUP" };

/** One mail as it left: who it went to and its raw text, headers and body. */
type Caught = { to: string[]; raw: string };

/**
 * nodemailer's stream transport, which builds each mail exactly as it would go out and hands it
 * back instead of sending it. Every mail it builds is kept.
 */
function catcher(): { transport: Transporter; caught: Caught[] } {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });
  const caught: Caught[] = [];
  const build = transport.sendMail.bind(transport) as (
    mail: SendMailOptions,
  ) => Promise<{ envelope: { to: string[] }; message: Buffer }>;
  vi.spyOn(transport, "sendMail").mockImplementation((async (mail: SendMailOptions) => {
    const info = await build(mail);
    caught.push({ to: info.envelope.to, raw: info.message.toString() });
    return info;
  }) as never);
  return { transport: transport as Transporter, caught };
}

/** A transport that always fails the way a mail server refusing the sign-in does. */
function failingTransport(): { transport: Transporter; tries: () => number } {
  let tries = 0;
  const transport = nodemailer.createTransport({
    name: "refuses",
    version: "1",
    send: (_mail, done) => {
      tries += 1;
      // A real error's message can quote the server's address, password included.
      const error = Object.assign(new Error(`Invalid login to ${MAIL_ENV.SMTP_URL}`), {
        code: "EAUTH",
        responseCode: 535,
      });
      done(error, undefined as never);
    },
  });
  return { transport: transport as Transporter, tries: () => tries };
}

/** The header lines of a raw mail, each folded line joined back to its header. */
function headersOf(raw: string): string[] {
  const head = raw.slice(0, raw.indexOf("\n\n"));
  return head.replace(/\n[ \t]+/g, " ").split("\n");
}

function header(raw: string, name: string): string | undefined {
  const line = headersOf(raw).find((h) => h.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}

type Row = {
  id: number;
  recipient_id: string;
  kind: string;
  state: string;
  attempts: number;
  last_error: string | null;
  not_sent_reason: string | null;
  sent_at: string | null;
};

function rows(db: Db): Row[] {
  return db.prepare("SELECT * FROM email_outbox ORDER BY id").all() as Row[];
}

/** A test app with one ticket and this many pending notices about it, ready to send. */
async function pendingNotices(howMany: number): Promise<Db> {
  const { app, db } = buildTestApp(MAIL_ENV);
  await ok(
    as(app, customerOne).post("/api/tickets").send({ title: "Printer jams", description: "x" }),
    201,
  );
  for (let event = 1; event <= howMany; event += 1) {
    db.prepare(
      `INSERT INTO email_outbox (event_id, ticket_id, recipient_id, kind, address, subject, body,
         state, created_at, updated_at)
       VALUES (?, 1, 'dev-customer-1', 'team_replied', 'dev-customer-1@example.com', 'Subject',
         'Body', 'pending', 'now', 'now')`,
    ).run(event);
  }
  return db;
}

/** A transport that hands each mail to this function instead of sending it. */
function transportOf(send: (messageId: string) => Promise<void>): Transporter {
  return nodemailer.createTransport({
    name: "test",
    version: "1",
    send: (mail, done) => {
      const messageId = String(mail.data.messageId);
      send(messageId).then(
        () => done(null, { messageId } as never),
        (err: Error) => done(err, undefined as never),
      );
    },
  }) as Transporter;
}

/** A test app with a mail server set, and a notifier sending through this transport. */
function mailingApp(transport: Transporter, env: NodeJS.ProcessEnv = MAIL_ENV) {
  const built = buildTestApp(env);
  const lines: string[] = [];
  const notifier = createNotifier({
    config: built.config,
    currentDb: () => built.db,
    log: (line) => lines.push(line),
    transport,
  });
  return { ...built, notifier, lines };
}

describe("sending notices", () => {
  it("sends a full ticket life's notices to exactly the right people, with no note text", async () => {
    const { transport, caught } = catcher();
    const { app, db, notifier } = mailingApp(transport);
    giveAddresses(db);
    await fullLife(app, () => notifier.run());
    expect(caught.map((mail) => `${mail.to.join(",")} ${header(mail.raw, "Subject")}`)).toEqual([
      "dev-customer-1@example.com [SUP-1] New reply: Printer jams",
      "dev-customer-1@example.com [SUP-1] Did this fix it? Printer jams",
      "dev-team-1@example.com [SUP-1] Not fixed yet: Printer jams",
      "dev-admin-1@example.com [SUP-1] Handed to you: Printer jams",
      "dev-admin-1@example.com [SUP-1] Customer replied: Printer jams",
      "dev-customer-1@example.com [SUP-1] Did this fix it? Printer jams",
      "dev-customer-2@example.com [SUP-2] Resolved: Export is empty",
      "dev-admin-1@example.com [SUP-2] Reopened: Export is empty",
    ]);
    for (const mail of caught) expect(mail.raw).not.toContain(NOTE_MARKER);
    for (const row of rows(db)) {
      expect(row.state).toBe("sent");
      expect(row.attempts).toBe(1);
      expect(row.sent_at).not.toBeNull();
    }
    // Running again sends nothing more.
    await notifier.run();
    expect(caught.length).toBe(8);
  });

  it("sends plain text a mail client threads by ticket, marked as sent by a machine", async () => {
    const { transport, caught } = catcher();
    const { app, db, notifier } = mailingApp(transport);
    giveAddresses(db);
    await fullLife(app, () => notifier.run());
    const [first, second] = caught as [Caught, Caught];
    expect(header(first.raw, "From")).toBe("Proofdesk <notices@example.com>");
    expect(header(first.raw, "Content-Type")).toMatch(/^text\/plain/);
    expect(header(first.raw, "Auto-Submitted")).toBe("auto-generated");
    expect(header(first.raw, "Message-ID")).toBe("<notice-1@example.com>");
    expect(header(second.raw, "Message-ID")).toBe("<notice-2@example.com>");
    // Every notice about SUP-1 refers to the same ticket, so they show as one conversation.
    expect(header(first.raw, "References")).toBe("<ticket-SUP-1@example.com>");
    expect(header(second.raw, "References")).toBe("<ticket-SUP-1@example.com>");
    expect(header(caught[6]!.raw, "References")).toBe("<ticket-SUP-2@example.com>");
  });

  it("cannot be made to add a header by a line break in a ticket title", async () => {
    const { transport, caught } = catcher();
    const { app, db, notifier } = mailingApp(transport);
    giveAddresses(db);
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Printer jams\r\nBcc: extra@example.com", description: "On page two." }),
      201,
    );
    await ok(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    await ok(
      as(app, teamActor).post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "On it." }),
      201,
    );
    await notifier.run();
    expect(caught.length).toBe(1);
    const [mail] = caught as [Caught];
    expect(mail.to).toEqual(["dev-customer-1@example.com"]);
    expect(headersOf(mail.raw).some((line) => /^bcc:/i.test(line))).toBe(false);
    expect(header(mail.raw, "Subject")).toBe(
      "[SUP-1] New reply: Printer jams Bcc: extra@example.com",
    );
  });

  it("fails a stored notice whose subject has a line break, without sending it", async () => {
    const { transport, caught } = catcher();
    const { app, db } = buildTestApp(MAIL_ENV);
    await ok(
      as(app, customerOne).post("/api/tickets").send({ title: "Printer jams", description: "x" }),
      201,
    );
    db.prepare(
      `INSERT INTO email_outbox (event_id, ticket_id, recipient_id, kind, address, subject, body,
         state, created_at, updated_at)
       VALUES (1, 1, 'dev-customer-1', 'team_replied', 'dev-customer-1@example.com',
         'Hello' || char(10) || 'Bcc: extra@example.com', 'Body', 'pending', 'now', 'now')`,
    ).run();
    await sendDueNotices(db, transport, SEND_SETTINGS);
    expect(caught).toEqual([]);
    const [row] = rows(db) as [Row];
    expect(row.state).toBe("failed");
    expect(row.last_error).toMatch(/line break/);
  });

  it("only sends to a verified address", async () => {
    const { transport, caught } = catcher();
    const { app, db, notifier } = mailingApp(transport);
    giveAddresses(db);
    db.prepare(`UPDATE "user" SET "emailVerified" = 0 WHERE id = 'dev-customer-1'`).run();
    await fullLife(app, () => notifier.run());
    expect(caught.length).toBe(5);
    expect(caught.some((mail) => mail.to.includes("dev-customer-1@example.com"))).toBe(false);
    const theirs = rows(db).filter((row) => row.recipient_id === "dev-customer-1");
    expect(theirs.map((row) => row.not_sent_reason)).toEqual([
      NOT_SENT_REASONS.unverified,
      NOT_SENT_REASONS.unverified,
      NOT_SENT_REASONS.unverified,
    ]);
  });
});

describe("when nothing may be sent", () => {
  it("sends nothing on the demo, even with a mail server set", async () => {
    const { transport, caught } = catcher();
    const { db, notifier, config } = mailingApp(transport, {
      ...MAIL_ENV,
      DEMO: "on",
      DEV_SIGN_IN: "off",
    });
    expect(config.mail).toBeNull();
    seedDemo(createTicketService(db, config.ticketPrefix));
    // Even a demo person with a verified address on file gets nothing.
    giveAddresses(db);
    await notifier.run();
    expect(rows(db).length).toBeGreaterThan(0);
    expect(caught).toEqual([]);
    for (const row of rows(db)) {
      expect(row.state).toBe("not_sent");
      expect(row.not_sent_reason).toBe(NOT_SENT_REASONS.demo);
    }
  });

  it("sends nothing when no mail server is set", async () => {
    const { transport, caught } = catcher();
    const { app, db, notifier } = mailingApp(transport, {});
    giveAddresses(db);
    await fullLife(app, () => notifier.run());
    expect(caught).toEqual([]);
    expect(rows(db).length).toBe(8);
    for (const row of rows(db)) {
      expect(row.state).toBe("not_sent");
      expect(row.not_sent_reason).toBe(NOT_SENT_REASONS.noMailServer);
    }
  });
});

describe("a mail server that fails", () => {
  it("is tried again with a longer wait each time, then the notice fails and says why", async () => {
    const { transport, tries } = failingTransport();
    const { app, db, config } = buildTestApp(MAIL_ENV);
    giveAddresses(db);
    await ok(
      as(app, customerOne).post("/api/tickets").send({ title: "Printer jams", description: "x" }),
      201,
    );
    await ok(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    await ok(
      as(app, teamActor).post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "On it." }),
      201,
    );
    const lines: string[] = [];
    const notifier = createNotifier({
      config,
      currentDb: () => db,
      log: (line) => lines.push(line),
      transport,
    });
    await notifier.run();
    expect(tries()).toBe(1);
    let [row] = rows(db) as [Row];
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("The mail server refused the sign-in. It answered 535.");

    // Not tried again before its wait is over.
    let clock = Date.now();
    await sendDueNotices(db, transport, SEND_SETTINGS, () => new Date(clock));
    expect(tries()).toBe(1);

    for (const wait of RETRY_WAITS_MS.slice(0, MOST_ATTEMPTS - 1)) {
      clock += wait + 1000;
      await sendDueNotices(db, transport, SEND_SETTINGS, () => new Date(clock));
    }
    expect(tries()).toBe(MOST_ATTEMPTS);
    [row] = rows(db) as [Row];
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(MOST_ATTEMPTS);
    expect(row.last_error).toBe("The mail server refused the sign-in. It answered 535.");

    // A failed notice is never tried again.
    clock += 24 * 60 * 60 * 1000;
    await sendDueNotices(db, transport, SEND_SETTINGS, () => new Date(clock));
    expect(tries()).toBe(MOST_ATTEMPTS);

    // The password the error quoted is nowhere: not in the row, not in a log line.
    expect(JSON.stringify(rows(db))).not.toContain(PASSWORD);
    expect(lines.join("\n")).not.toContain(PASSWORD);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("keeps only a code and an answer number from an error", () => {
    expect(plainReason(new Error(`connect to ${MAIL_ENV.SMTP_URL} failed`))).toBe(
      "The mail could not be sent.",
    );
    expect(plainReason(Object.assign(new Error("x"), { code: "ECONNECTION" }))).toBe(
      "The mail server could not be reached.",
    );
    expect(plainReason(Object.assign(new Error("x"), { code: "EWHATEVER" }))).toBe(
      "The mail could not be sent (EWHATEVER).",
    );
    // A code that is not a plain code is left out.
    expect(plainReason({ code: `E ${PASSWORD}`, responseCode: 550 })).toBe(
      "The mail could not be sent. It answered 550.",
    );
  });
});

describe("two senders at once", () => {
  it("never send one notice twice", async () => {
    let delivered: string[] = [];
    // A slow transport, so both senders are mid-send at the same time.
    const slow = nodemailer.createTransport({
      name: "slow",
      version: "1",
      send: (mail, done) => {
        delivered.push(String(mail.data.messageId));
        setTimeout(() => done(null, { messageId: mail.data.messageId } as never), 20);
      },
    }) as Transporter;
    const { app, db, config } = buildTestApp(MAIL_ENV);
    giveAddresses(db);
    const notifier = createNotifier({
      config,
      currentDb: () => db,
      log: () => undefined,
      transport: slow,
    });
    await fullLife(app, () => notifier.run());
    delivered = [];
    // Back to pending, as if never sent, and two separate connections to the same file: two
    // processes.
    db.prepare(
      "UPDATE email_outbox SET state = 'pending', attempts = 0, sent_at = NULL, next_attempt_at = NULL",
    ).run();
    const other = openDatabase(db.name);
    try {
      await Promise.all([
        sendDueNotices(db, slow, SEND_SETTINGS),
        sendDueNotices(other, slow, SEND_SETTINGS),
        sendDueNotices(db, slow, SEND_SETTINGS),
        sendDueNotices(other, slow, SEND_SETTINGS),
      ]);
    } finally {
      other.close();
    }
    expect(delivered.length).toBe(8);
    expect(new Set(delivered).size).toBe(8);
    expect(rows(db).every((row) => row.state === "sent" && row.attempts === 1)).toBe(true);
  });
});

describe("two senders and a slow mail server", () => {
  it("never send one notice twice, however long each mail takes", async () => {
    const db = await pendingNotices(SEND_BATCH);
    // A second connection to the same file, as a second process would hold.
    const other = openDatabase(db.name);
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const now = () => new Date(clock);
    const delivered: string[] = [];
    let secondSenderTried = 0;
    const quick = transportOf(async (id) => {
      delivered.push(id);
    });
    // Each mail from the first sender takes fifteen seconds, and while it is on its way the
    // second sender's timer ticks.
    const slow = transportOf(async (id) => {
      clock += 15 * 1000;
      const before = delivered.length;
      await sendDueNotices(other, quick, SEND_SETTINGS, now);
      secondSenderTried += delivered.length - before;
      delivered.push(id);
    });
    try {
      await sendDueNotices(db, slow, SEND_SETTINGS, now);
    } finally {
      other.close();
    }
    expect(secondSenderTried).toBeGreaterThan(0);
    expect(delivered.length).toBe(SEND_BATCH);
    expect(new Set(delivered).size).toBe(SEND_BATCH);
    expect(rows(db).every((row) => row.state === "sent" && row.attempts === 1)).toBe(true);
  });

  it("takes no notice another sender changed first", async () => {
    const db = await pendingNotices(1);
    const at = new Date().toISOString();
    const until = new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
    expect(claimNotice(db, 1, 0, at, until)).toBe(true);
    // A second claim made from the same earlier reading of the notice finds it changed.
    expect(claimNotice(db, 1, 0, at, until)).toBe(false);
    db.prepare("UPDATE email_outbox SET state = 'sent' WHERE id = 1").run();
    expect(claimNotice(db, 1, 1, at, until)).toBe(false);
    expect((rows(db)[0] as Row).attempts).toBe(1);
  });

  it("waits only the retry wait after a failed try, not the whole hold of the claim", async () => {
    const db = await pendingNotices(1);
    let clock = Date.parse("2026-01-01T00:00:00Z");
    let tries = 0;
    const refuses = transportOf(async () => {
      tries += 1;
      throw Object.assign(new Error("refused"), { code: "ECONNECTION" });
    });
    await sendDueNotices(db, refuses, SEND_SETTINGS, () => new Date(clock));
    expect(tries).toBe(1);
    clock += RETRY_WAITS_MS[0]! + 1000;
    expect(RETRY_WAITS_MS[0]! + 1000).toBeLessThan(CLAIM_LEASE_MS);
    await sendDueNotices(db, refuses, SEND_SETTINGS, () => new Date(clock));
    expect(tries).toBe(2);
  });
});

describe("the server stopping mid-send", () => {
  it("ends quietly, and counts a try only for the notice that was on its way", async () => {
    const db = await pendingNotices(3);
    const closes = transportOf(async () => {
      db.close();
    });
    await expect(sendDueNotices(db, closes, SEND_SETTINGS)).resolves.toEqual({
      sent: 0,
      failed: 0,
    });
    const reopened = openDatabase(db.name);
    try {
      const after = reopened
        .prepare("SELECT state, attempts FROM email_outbox ORDER BY id")
        .all() as { state: string; attempts: number }[];
      expect(after).toEqual([
        { state: "pending", attempts: 1 },
        { state: "pending", attempts: 0 },
        { state: "pending", attempts: 0 },
      ]);
    } finally {
      reopened.close();
    }
  });
});

describe("switching email off", () => {
  it("also stops the notices already waiting to be sent", async () => {
    const { transport, caught } = catcher();
    const db = await pendingNotices(1);
    saveEmailMe(db, "dev-customer-1", false, new Date().toISOString());
    const result = await sendDueNotices(db, transport, SEND_SETTINGS);
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(caught).toEqual([]);
    const [row] = rows(db);
    expect(row!.state).toBe("not_sent");
    expect(row!.not_sent_reason).toBe(NOT_SENT_REASONS.switchedOff);
  });
});

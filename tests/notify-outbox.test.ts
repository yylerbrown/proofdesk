import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";
import {
  collectNotices,
  NOT_SENT_REASONS,
  noticesForViewer,
  type NotifySettings,
} from "../src/server/notify/outbox.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  handToAgent,
  teamActor,
} from "./helpers.js";

// Email notices worked out from the ticket history. The one failure that would really hurt is
// a customer emailed the text of an internal note, so every note here carries a marker that is
// looked for in every notice.

const NOTE_MARKER = "INTERNAL-ONLY-7731";

const MIGRATIONS = path.join(__dirname, "..", "migrations");

const SETTINGS: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test/",
  demo: false,
  mailConfigured: true,
};

/** Gives the made-up people of the development entrance an address, as signing in would. */
function giveAddresses(db: Db) {
  const insert = db.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, '2026-01-01', '2026-01-01')`,
  );
  for (const person of [customerOne, customerTwo, teamActor, adminActor]) {
    insert.run(person.id, person.name, `${person.id}@example.com`);
  }
}

type Row = {
  ticket_id: number;
  recipient_id: string;
  kind: string;
  address: string;
  subject: string;
  body: string;
  state: string;
  not_sent_reason: string | null;
};

function allNotices(db: Db): Row[] {
  return db.prepare("SELECT * FROM email_outbox ORDER BY id").all() as Row[];
}

/** The notices as "ticket recipient kind", the easiest form to compare. */
function summary(db: Db): string[] {
  return allNotices(db).map((n) => `SUP-${n.ticket_id} ${n.recipient_id} ${n.kind}`);
}

async function ok(res: request.Response | Promise<request.Response>, status = 200) {
  const done = await res;
  expect(done.status, done.text).toBe(status);
  return done;
}

async function issueKey(app: Express): Promise<string> {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "attach_evidence", "write_notes"] });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

/**
 * A full ticket life, collecting after every step as the server will. On SUP-1: filed, taken,
 * a team reply, an internal note, an assistant's evidence and note, the customer asked, a No,
 * a hand-off, a reply from the customer, asked again, a Yes. On SUP-2: a team resolution, then
 * a reopen.
 */
async function fullLife(app: Express, db: Db, settings: NotifySettings = SETTINGS) {
  const step = async (res: Promise<request.Response>, status = 200) => {
    const done = await ok(res, status);
    collectNotices(db, settings);
    return done;
  };
  await step(
    as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "On page two.", fix_check: "Ten pages print" }),
    201,
  );
  await step(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
  await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Looking at it now." }),
    201,
  );
  await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: `Customer seems upset. ${NOTE_MARKER}` }),
    201,
  );
  const key = await issueKey(app);
  await handToAgent(app, "SUP-1", key);
  collectNotices(db, settings);
  const agent = (path: string) => request(app).post(path).set("Authorization", `Bearer ${key}`);
  await step(
    agent("/api/tickets/SUP-1/evidence").send({
      kind: "test",
      summary: "A test prints ten pages",
      link: "https://example.com/pr/7",
      result: "passed",
    }),
    201,
  );
  await step(
    agent("/api/tickets/SUP-1/notes").send({ body: `Root cause found. ${NOTE_MARKER}` }),
    201,
  );
  await step(
    as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/change/1" }),
  );
  const first = await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/try", tried: "Printed ten.", result: "No jam." }),
  );
  await step(
    as(app, customerOne).post("/api/tickets/SUP-1/answer").send({
      fixed: "no",
      comment: "It jammed on page nine.",
      ready_token: first.body.ready_token,
    }),
  );
  await step(
    as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: adminActor.id, expected_owner: teamActor.id }),
  );
  await step(
    as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "It is the thick paper." }),
    201,
  );
  const second = await step(
    admin(app).post("/api/tickets/SUP-1/ready").send({
      try_url: "https://example.com/try",
      tried: "Printed ten on thick paper.",
      result: "No jam.",
      response: "The thick paper tray is fixed now.",
    }),
  );
  await step(
    as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: second.body.ready_token }),
  );

  await step(
    as(app, customerTwo)
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "The file has no rows." }),
    201,
  );
  await step(admin(app).post("/api/tickets/SUP-2/take-and-start"));
  await step(
    admin(app)
      .post("/api/tickets/SUP-2/resolve")
      .send({ reason: "duplicate", duplicate_of: "SUP-1", note: `Team only. ${NOTE_MARKER}` }),
  );
  await step(
    as(app, customerTwo).post("/api/tickets/SUP-2/reopen").send({ reason: "Still empty today." }),
  );
}

describe("notices from a full ticket life", () => {
  it("writes exactly the notices someone must hear about", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    expect(summary(db)).toEqual([
      "SUP-1 dev-customer-1 team_replied",
      "SUP-1 dev-customer-1 asked_to_check",
      "SUP-1 dev-team-1 customer_said_no",
      "SUP-1 dev-admin-1 handed_to_you",
      "SUP-1 dev-admin-1 customer_replied",
      "SUP-1 dev-customer-1 asked_to_check",
      "SUP-2 dev-customer-2 resolved_by_team",
      "SUP-2 dev-admin-1 customer_reopened",
    ]);
    for (const notice of allNotices(db)) {
      expect(notice.address).toBe(`${notice.recipient_id}@example.com`);
      expect(notice.state).toBe("pending");
      expect(notice.not_sent_reason).toBeNull();
    }
  });

  it("never puts the text of an internal note in a notice", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    expect(allNotices(db).length).toBeGreaterThan(0);
    for (const notice of allNotices(db)) {
      expect(notice.subject).not.toContain(NOTE_MARKER);
      expect(notice.body).not.toContain(NOTE_MARKER);
    }
  });

  it("says who did what, links to the ticket and says why", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    const [reply, asked, no] = allNotices(db) as [Row, Row, Row];
    expect(reply.subject).toBe("[SUP-1] New reply: Printer jams");
    expect(reply.body).toContain('Team Member replied on ticket SUP-1, "Printer jams":');
    expect(reply.body).toContain('"Looking at it now."');
    expect(asked.subject).toBe("[SUP-1] Did this fix it? Printer jams");
    expect(asked.body).toContain("Did this fix it?");
    expect(asked.body).toContain("Check it here: https://example.com/try");
    expect(asked.body).toContain("Answer Yes or No on the ticket: https://desk.test/tickets/SUP-1");
    expect(asked.body.split("\n").at(-1)).toBe("You got this email because you filed this ticket.");
    expect(no.body).toContain('"It jammed on page nine."');
    expect(no.body.split("\n").at(-1)).toBe("You got this email because you own this ticket.");
    const resolved = allNotices(db).find((n) => n.kind === "resolved_by_team")!;
    expect(resolved.body).toContain("The reason: Duplicate of SUP-1.");
    expect(resolved.body).toContain("you can reopen it");
  });
});

describe("collecting notices", () => {
  it("adds nothing when it runs again", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    const before = summary(db);
    expect(collectNotices(db, SETTINGS)).toEqual({ events: 0, notices: 0 });
    // Even from the very start of the history: the unique key refuses every double.
    db.prepare("UPDATE email_outbox_cursor SET last_event_id = 0").run();
    expect(collectNotices(db, SETTINGS).notices).toBe(0);
    expect(summary(db)).toEqual(before);
  });

  it("collects late just as well, except for an owner who has handed the ticket on", async () => {
    const live = buildTestApp();
    giveAddresses(live.db);
    await fullLife(live.app, live.db);

    // The same life with nothing collected until the end.
    const late = buildTestApp();
    giveAddresses(late.db);
    await fullLife(late.app, late.db, { ...SETTINGS });
    late.db.prepare("DELETE FROM email_outbox").run();
    late.db.prepare("UPDATE email_outbox_cursor SET last_event_id = 0").run();
    collectNotices(late.db, SETTINGS);
    // The No reached Team Member while they owned the ticket. Collected after the hand-off,
    // it is not sent to the new owner, who hears of the ticket through the hand-off.
    expect(summary(late.db)).toEqual(
      summary(live.db).filter((line) => line !== "SUP-1 dev-team-1 customer_said_no"),
    );
  });

  it("writes no row for someone with no stored address", async () => {
    const { app, db } = buildTestApp();
    // Nobody has signed in, so nobody has an address.
    await fullLife(app, db);
    expect(allNotices(db)).toEqual([]);
  });

  it("keeps every notice unsent on the demo, with the reason", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db, { ...SETTINGS, demo: true });
    expect(allNotices(db).length).toBe(8);
    for (const notice of allNotices(db)) {
      expect(notice.state).toBe("not_sent");
      expect(notice.not_sent_reason).toBe(NOT_SENT_REASONS.demo);
    }
  });

  it("keeps every notice unsent when no mail server is set up", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db, { ...SETTINGS, mailConfigured: false });
    for (const notice of allNotices(db)) {
      expect(notice.state).toBe("not_sent");
      expect(notice.not_sent_reason).toBe(NOT_SENT_REASONS.noMailServer);
    }
  });

  it("starts after the history a database already holds", () => {
    // A database from before notices, holding one ticket and its first event.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-notify-"));
    const all = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
    for (const name of all.filter((n) => n < "0026")) {
      fs.copyFileSync(path.join(MIGRATIONS, name), path.join(dir, name));
    }
    const db = openDatabase(":memory:");
    try {
      runMigrations(db, dir);
      db.prepare(
        `INSERT INTO tickets (title, description, created_by, created_at, updated_at)
         VALUES ('Old', 'Old ticket', 'dev-customer-1', 'then', 'then')`,
      ).run();
      db.prepare(
        `INSERT INTO ticket_events (ticket_id, actor, type, data, created_at)
         VALUES (1, 'dev-team-1', 'ready_for_customer', '{}', 'then')`,
      ).run();
      fs.copyFileSync(
        path.join(MIGRATIONS, "0026_email_outbox.sql"),
        path.join(dir, "0026_email_outbox.sql"),
      );
      runMigrations(db, dir);
      expect(db.prepare("SELECT last_event_id FROM email_outbox_cursor").get()).toEqual({
        last_event_id: 1,
      });
      giveAddresses(db);
      expect(collectNotices(db, SETTINGS)).toEqual({ events: 0, notices: 0 });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes a ticket's notices with it, and still reads the events that reuse its ids", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    await ok(admin(app).post("/api/tickets/SUP-2/archive"));
    await ok(admin(app).delete("/api/tickets/SUP-2").send({ confirm: "SUP-2" }));
    expect(summary(db).filter((line) => line.startsWith("SUP-2"))).toEqual([]);
    // SUP-2's events were the newest. The next events take their ids, and are still read.
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Scanner is slow", description: "Very slow.", fix_check: "Fast" }),
      201,
    );
    await ok(admin(app).post("/api/tickets/SUP-3/take-and-start"));
    await ok(
      admin(app).post("/api/tickets/SUP-3/entries").send({ kind: "reply", body: "On it." }),
      201,
    );
    collectNotices(db, SETTINGS);
    expect(summary(db).at(-1)).toBe("SUP-3 dev-customer-1 team_replied");
  });

  it("refuses to change what a written notice says", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    expect(() => db.prepare("UPDATE email_outbox SET body = 'changed'").run()).toThrow(
      /only their state can change/,
    );
    db.prepare("UPDATE email_outbox SET state = 'sent', attempts = 1").run();
  });
});

describe("who sees which notices", () => {
  it("shows a customer only their own, the team all, and an assistant none", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await fullLife(app, db);
    const kinds = (rows: { recipient_id: string; kind: string }[]) =>
      rows.map((n) => `${n.recipient_id} ${n.kind}`);
    expect(kinds(noticesForViewer(db, 1, customerOne))).toEqual([
      "dev-customer-1 team_replied",
      "dev-customer-1 asked_to_check",
      "dev-customer-1 asked_to_check",
    ]);
    expect(noticesForViewer(db, 1, customerTwo)).toEqual([]);
    expect(noticesForViewer(db, 1, teamActor).length).toBe(6);
    expect(noticesForViewer(db, 1, adminActor).length).toBe(6);
    const assistant = { id: "connection-1", kind: "agent", role: "team", name: "Helper" } as const;
    expect(noticesForViewer(db, 1, assistant)).toEqual([]);
  });
});

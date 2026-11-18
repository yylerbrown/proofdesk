import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_ACTORS } from "../src/server/actor.js";
import { openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";
import {
  collectNotices,
  NOT_SENT_REASONS,
  NOTICES_PER_TICKET_PER_HOUR,
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
  teamActor,
} from "./helpers.js";
import { fullLife as lifeOf, giveAddresses, NOTE_MARKER, ok } from "./notify-life.js";

// Email notices worked out from the ticket history. The one failure that would really hurt is
// a customer emailed the text of an internal note, so every note here carries a marker that is
// looked for in every notice.

const MIGRATIONS = path.join(__dirname, "..", "migrations");

const SETTINGS: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test/",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  // The tests get in through the development entrance, whose made-up people keep their roles.
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

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

/** The full ticket life, collecting with these settings after every step. */
function fullLife(app: Express, db: Db, settings: NotifySettings = SETTINGS) {
  return lifeOf(app, () => collectNotices(db, settings));
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
    // The note with a resolution is public: the ticket page shows it to the customer too.
    expect(resolved.body).toContain('"Same printer as SUP-1."');
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
    // No page is handed anyone's address, not even the team's.
    for (const viewer of [customerOne, teamActor, adminActor]) {
      for (const notice of noticesForViewer(db, 1, viewer))
        expect(notice).not.toHaveProperty("address");
    }
    const assistant = { id: "connection-1", kind: "agent", role: "team", name: "Helper" } as const;
    expect(noticesForViewer(db, 1, assistant)).toEqual([]);
  });
});

describe("the words a notice quotes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("quotes the public reply, never a note written by the same person at the same moment", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Printer jams", description: "On page two." }),
      201,
    );
    await ok(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    // The reply and the note share the same author and the same timestamp, so only the kind
    // of entry tells them apart.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-03-01T10:00:00.000Z") });
    await ok(
      as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "reply", body: "Public words." }),
      201,
    );
    await ok(
      as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "note", body: `Private words. ${NOTE_MARKER}` }),
      201,
    );
    collectNotices(db, SETTINGS);
    expect(summary(db)).toEqual(["SUP-1 dev-customer-1 team_replied"]);
    const [reply] = allNotices(db) as [Row];
    expect(reply.body).toContain('"Public words."');
    expect(reply.body).not.toContain(NOTE_MARKER);
  });
});

describe("who hears about a reply", () => {
  it("tells the owner when the person who filed replies, whatever their role", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    // A team member files a ticket, and the admin owns it.
    await ok(
      as(app, teamActor)
        .post("/api/tickets")
        .send({ title: "Laptop is slow", description: "Very slow." }),
      201,
    );
    await ok(admin(app).post("/api/tickets/SUP-1/take-and-start"));
    await ok(
      as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "reply", body: "Still slow." }),
      201,
    );
    await ok(
      admin(app).post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "Looking." }),
      201,
    );
    collectNotices(db, SETTINGS);
    expect(summary(db)).toEqual([
      "SUP-1 dev-admin-1 customer_replied",
      "SUP-1 dev-team-1 team_replied",
    ]);
  });
});

describe("a hand-off from someone with no stored name", () => {
  it("says a teammate handed it on, never the customer", async () => {
    const { app, db } = buildTestApp();
    // Only the new owner has signed in.
    db.prepare(
      `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       VALUES ('dev-admin-1', 'Admin', 'dev-admin-1@example.com', 1, '2026-01-01', '2026-01-01')`,
    ).run();
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Hand me on", description: "Please." }),
      201,
    );
    await ok(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    await ok(
      as(app, teamActor)
        .post("/api/tickets/SUP-1/hand-off")
        .send({ to: adminActor.id, expected_owner: teamActor.id }),
    );
    collectNotices(db, SETTINGS);
    const [handed] = allNotices(db) as [Row];
    expect(handed.kind).toBe("handed_to_you");
    expect(handed.body).toContain('A teammate handed ticket SUP-1, "Hand me on" to you.');
  });
});

describe("an address that is not verified", () => {
  it("is never sent to: its notices are kept as not sent, saying why", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    db.prepare(`UPDATE "user" SET "emailVerified" = 0 WHERE id = 'dev-customer-1'`).run();
    await fullLife(app, db);
    const theirs = allNotices(db).filter((n) => n.recipient_id === "dev-customer-1");
    expect(theirs.length).toBe(3);
    for (const notice of theirs) {
      expect(notice.state).toBe("not_sent");
      expect(notice.not_sent_reason).toBe(NOT_SENT_REASONS.unverified);
    }
    // Everyone else's are still pending.
    const others = allNotices(db).filter((n) => n.recipient_id !== "dev-customer-1");
    expect(others.every((n) => n.state === "pending")).toBe(true);
  });
});

describe("many notices about one ticket to one person", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A ticket owned by the team member, and the customer's replies on it, collected after each. */
  async function replies(howMany: number, app: Express, db: Db) {
    for (let i = 1; i <= howMany; i += 1) {
      await ok(
        as(app, customerOne)
          .post("/api/tickets/SUP-1/entries")
          .send({ kind: "reply", body: `More detail, part ${i}.` }),
        201,
      );
      collectNotices(db, SETTINGS);
    }
  }

  async function ownedTicket() {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await ok(
      as(app, customerOne).post("/api/tickets").send({ title: "Printer jams", description: "x" }),
      201,
    );
    await ok(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    collectNotices(db, SETTINGS);
    return { app, db };
  }

  function ownerReplies(db: Db): { state: string; not_sent_reason: string | null }[] {
    return allNotices(db)
      .filter((n) => n.recipient_id === teamActor.id && n.kind === "customer_replied")
      .map(({ state, not_sent_reason }) => ({ state, not_sent_reason }));
  }

  it(`sends at most ${NOTICES_PER_TICKET_PER_HOUR} an hour, and keeps the rest as not sent`, async () => {
    const { app, db } = await ownedTicket();
    await replies(20, app, db);
    const owner = ownerReplies(db);
    expect(owner).toHaveLength(20);
    const pending = owner.filter((n) => n.state === "pending");
    const held = owner.filter((n) => n.state === "not_sent");
    expect(pending).toHaveLength(NOTICES_PER_TICKET_PER_HOUR);
    expect(held).toHaveLength(20 - NOTICES_PER_TICKET_PER_HOUR);
    for (const notice of held) expect(notice.not_sent_reason).toBe(NOT_SENT_REASONS.tooMany);
  });

  it("sends again once the hour has passed, and never holds back a few honest replies", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T09:00:00.000Z"));
    const { app, db } = await ownedTicket();
    await replies(2, app, db);
    expect(ownerReplies(db).map((n) => n.state)).toEqual(["pending", "pending"]);
    await replies(NOTICES_PER_TICKET_PER_HOUR - 1, app, db);
    expect(ownerReplies(db).at(-1)!.state).toBe("not_sent");
    vi.setSystemTime(new Date("2026-11-18T10:01:00.000Z"));
    await replies(1, app, db);
    expect(ownerReplies(db).at(-1)!.state).toBe("pending");
  });
});

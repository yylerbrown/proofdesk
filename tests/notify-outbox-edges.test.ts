import { describe, expect, it } from "vitest";
import { DEV_ACTORS } from "../src/server/actor.js";
import type { Db } from "../src/server/db.js";
import { collectNotices, type NotifySettings } from "../src/server/notify/outbox.js";
import { as, buildTestApp, customerOne } from "./helpers.js";
import { giveAddresses, ok } from "./notify-life.js";

// Notices worked out from history events that the usual ticket life never writes: an event
// about a ticket that is gone, a reply event whose reply is gone, a sender nobody knows, and
// event data that is not what it should be. Each is written straight into the history, as a
// change from an older version of the site or a half-finished one would leave it.

const SETTINGS: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test/",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

const NOBODY = "someone-no-longer-here";

type Notice = { recipient_id: string; kind: string; body: string };

/** A test app with addresses for everyone and one ticket, owned by a team member. */
async function oneTicket(): Promise<Db> {
  const { app, db } = buildTestApp();
  giveAddresses(db);
  await ok(
    as(app, customerOne).post("/api/tickets").send({ title: "Printer jams", description: "x" }),
    201,
  );
  db.prepare(
    "UPDATE tickets SET status = 'in_progress', owner_id = 'dev-team-1', owner_name = 'Owner Name' WHERE id = 1",
  ).run();
  // Everything that happened so far is collected, so each test sees only its own events.
  collectNotices(db, SETTINGS);
  db.prepare("DELETE FROM email_outbox").run();
  return db;
}

/** Writes one history event straight into the table. */
function event(db: Db, type: string, data: string, actor = NOBODY, ticketId = 1): void {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, actor, type, data, created_at)
     VALUES (?, ?, ?, ?, '2026-01-02T00:00:00.000Z')`,
  ).run(ticketId, actor, type, data);
}

function notices(db: Db): Notice[] {
  return db
    .prepare("SELECT recipient_id, kind, body FROM email_outbox ORDER BY id")
    .all() as Notice[];
}

describe("an event no notice can be made from", () => {
  it("gives none when its ticket no longer exists", async () => {
    const db = await oneTicket();
    db.pragma("foreign_keys = OFF");
    event(db, "resolved_by_team", JSON.stringify({ reason: "wont_fix" }), NOBODY, 99);
    db.pragma("foreign_keys = ON");
    expect(collectNotices(db, SETTINGS)).toEqual({ events: 1, notices: 0 });
  });

  it("gives none for a reply whose reply is gone", async () => {
    const db = await oneTicket();
    event(db, "reply_added", "{}", "dev-team-1");
    expect(collectNotices(db, SETTINGS)).toEqual({ events: 1, notices: 0 });
  });
});

describe("a sender nobody knows", () => {
  it("is the support team to the customer", async () => {
    const db = await oneTicket();
    event(db, "resolved_by_team", JSON.stringify({ reason: "wont_fix" }));
    collectNotices(db, SETTINGS);
    const [notice] = notices(db);
    expect(notice).toMatchObject({ recipient_id: "dev-customer-1", kind: "resolved_by_team" });
    expect(notice!.body).toContain("The support team");
  });

  it("is a teammate to the person a ticket is handed to", async () => {
    const db = await oneTicket();
    event(db, "owner_changed", JSON.stringify({ to: "Owner Name" }));
    collectNotices(db, SETTINGS);
    const [notice] = notices(db);
    expect(notice).toMatchObject({ recipient_id: "dev-team-1", kind: "handed_to_you" });
    expect(notice!.body).toContain("A teammate");
  });

  it("is the customer to the owner of a reopened ticket", async () => {
    const db = await oneTicket();
    event(db, "owner_changed", JSON.stringify({ to: "Owner Name" }), "dev-admin-1");
    event(db, "reopened", JSON.stringify({ reason: "Still jams" }));
    collectNotices(db, SETTINGS);
    const reopened = notices(db).find((n) => n.kind === "customer_reopened");
    expect(reopened?.recipient_id).toBe("dev-team-1");
    expect(reopened!.body).toContain("The customer");
  });
});

describe("event data that is not what it should be", () => {
  it.each([
    ["is not JSON", "not json at all"],
    ["names a reason the site does not know", JSON.stringify({ reason: "lost_interest" })],
  ])("still tells the customer the team resolved it when the data %s", async (_name, data) => {
    const db = await oneTicket();
    event(db, "resolved_by_team", data);
    collectNotices(db, SETTINGS);
    const [notice] = notices(db);
    expect(notice).toMatchObject({ recipient_id: "dev-customer-1", kind: "resolved_by_team" });
    // No reason is made up for it.
    expect(notice!.body).not.toContain("Won't fix");
    expect(notice!.body).not.toContain("Duplicate of");
  });
});

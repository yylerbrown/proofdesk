import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_ACTORS } from "../src/server/actor.js";
import type { Db } from "../src/server/db.js";
import { collectNotices, type NotifySettings } from "../src/server/notify/outbox.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";
import { giveAddresses } from "./notify-life.js";

// Marking a ticket fixed tells the customer and puts the question to them. So after the
// customer says it is not fixed, the team may mark it fixed again: it overrides nothing, and
// the customer is told again.

const SETTINGS: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

const filed = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const stillWrong = "It still jams on page two.";

/** SUP-1 filed by the customer, taken and started by the team member, and marked fixed. */
async function markedFixed() {
  const built = buildTestApp();
  giveAddresses(built.db);
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const res = await markFixed(built.app);
  expect(res.status, res.text).toBe(200);
  collectNotices(built.db, SETTINGS);
  return built;
}

const markFixed = (app: Express) =>
  as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });

function noticeKinds(db: Db): string[] {
  const rows = db.prepare("SELECT recipient_id, kind FROM email_outbox ORDER BY id").all() as {
    recipient_id: string;
    kind: string;
  }[];
  return rows.map((row) => `${row.recipient_id} ${row.kind}`);
}

describe("the customer's No to a ticket marked fixed", () => {
  it("puts it back with its owner, keeps their words once and tells the owner", async () => {
    const { app, db } = await markedFixed();
    const no = await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: stillWrong });
    expect(no.status, no.text).toBe(200);
    expect([no.body.status, no.body.owner_id]).toEqual(["in_progress", teamActor.id]);
    const entries = (await admin(app).get("/api/tickets/SUP-1/entries")).body as {
      body: string;
    }[];
    expect(entries.filter((entry) => entry.body === stillWrong)).toHaveLength(1);
    collectNotices(db, SETTINGS);
    expect(noticeKinds(db)).toEqual([
      "dev-customer-1 marked_fixed",
      "dev-team-1 customer_reopened",
    ]);
  });

  it("lets the team mark it fixed again, which tells the customer again", async () => {
    const { app, db } = await markedFixed();
    await as(app, customerOne).post("/api/tickets/SUP-1/reopen").send({ reason: stillWrong });
    collectNotices(db, SETTINGS);
    const again = await markFixed(app);
    expect(again.status, again.text).toBe(200);
    expect(again.body.resolution).toMatchObject({ by: "team", reason: "fixed_no_reply" });
    collectNotices(db, SETTINGS);
    expect(noticeKinds(db)).toEqual([
      "dev-customer-1 marked_fixed",
      "dev-team-1 customer_reopened",
      "dev-customer-1 marked_fixed",
    ]);
  });

  it("after a No to the question, also lets the team mark it fixed", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const asked = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "no", comment: stillWrong, ready_token: asked.body.ready_token });
    const res = await markFixed(app);
    expect(res.status, res.text).toBe(200);
    expect(res.body.resolution.reason).toBe("fixed_no_reply");
  });
});

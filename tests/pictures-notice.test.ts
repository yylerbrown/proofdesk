import { describe, expect, it } from "vitest";
import { DEV_ACTORS } from "../src/server/actor.js";
import { composeNotice } from "../src/server/notify/compose.js";
import { collectNotices, type NotifySettings } from "../src/server/notify/outbox.js";
import { samplePicture } from "../src/server/pictures/sample.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";
import { giveAddresses } from "./notify-life.js";

// An email notice for a message with pictures says how many are on the ticket and never
// carries them, so a picture is only ever seen by someone who can open the ticket.

const base = {
  kind: "team_replied" as const,
  ticketKey: "SUP-4",
  title: "Printer jams",
  siteUrl: "https://desk.test",
  recipientName: "Customer One",
  actorName: "Team Member",
  publicText: "Here is the fix.",
};

const SETTINGS: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test/",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

describe("a reply notice with pictures", () => {
  it("names how many, in one line under the quoted reply", () => {
    const lines = composeNotice({ ...base, pictureCount: 2 }).body.split("\n");
    expect(lines[lines.indexOf('"Here is the fix."') + 1]).toBe(
      "(2 pictures attached to the ticket)",
    );
    expect(composeNotice({ ...base, pictureCount: 1 }).body).toContain(
      "(1 picture attached to the ticket)",
    );
    expect(composeNotice({ ...base, kind: "customer_replied", pictureCount: 3 }).body).toContain(
      "(3 pictures attached to the ticket)",
    );
  });

  it("says nothing of pictures when there are none", () => {
    expect(composeNotice(base).body).not.toContain("picture");
    expect(composeNotice({ ...base, pictureCount: 0 }).body).not.toContain("picture");
  });

  it("is written from the reply's own pictures, and carries no bytes", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "On page two", fix_check: "Ten pages print" });
    const picture = samplePicture();
    await as(app, teamActor)
      .post("/tickets/SUP-1/entries")
      .field("kind", "reply")
      .field("body", "Here is the fix.")
      .attach("pictures", picture, "a.png")
      .attach("pictures", picture, "b.png");
    collectNotices(db, SETTINGS);
    const notice = db
      .prepare("SELECT body FROM email_outbox WHERE kind = 'team_replied'")
      .get() as { body: string };
    expect(notice.body).toContain("(2 pictures attached to the ticket)");
    expect(notice.body).not.toContain("/pictures/");
    expect(notice.body.length).toBeLessThan(1000);
  });
});

import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_ACTORS, DEV_COOKIE, type Actor } from "../src/server/actor.js";
import type { Db } from "../src/server/db.js";
import {
  collectNotices,
  madeUpPeopleOf,
  NOT_SENT_REASONS,
  notifySettingsOf,
  type NotifySettings,
} from "../src/server/notify/outbox.js";
import { noticeCountFor, noticeStateWords } from "../src/server/notify/view.js";
import {
  adminActor,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  teamActor,
  visitor,
} from "./helpers.js";
import { fullLife, giveAddresses, NOTE_MARKER, ok } from "./notify-life.js";

// The notices page: what a ticket emailed, or would have emailed, as each viewer may see it.

const WITH_MAIL: NotifySettings = {
  ticketPrefix: "SUP",
  siteUrl: "https://desk.test",
  demo: false,
  mailConfigured: true,
  madeUpPeople: [],
  // The tests get in through the development entrance, whose made-up people keep their roles.
  roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
};

/** The notices the page lists, each as its "To ..." line. */
function recipients(html: string): string[] {
  return parse(html)
    .querySelectorAll("article.email .email-to")
    .map((line) => line.text);
}

/** The quiet tag of each notice on the page, which says what happened to it. */
function states(html: string): string[] {
  return parse(html)
    .querySelectorAll("article.email .email-state")
    .map((tag) => tag.text);
}

async function lifeWithNotices(settings: NotifySettings = WITH_MAIL) {
  const { app, db } = buildTestApp();
  giveAddresses(db);
  await fullLife(app, () => collectNotices(db, settings));
  return { app, db };
}

describe("the notices page", () => {
  it("shows the customer only their own notices, newest first", async () => {
    const { app } = await lifeWithNotices();
    const res = await ok(as(app, customerOne).get("/tickets/SUP-1/notices"));
    expect(recipients(res.text)).toEqual(["To You", "To You", "To You"]);
    const subjects = parse(res.text)
      .querySelectorAll("article.email .email-subject")
      .map((line) => line.text);
    expect(subjects).toEqual([
      "[SUP-1] Did this fix it? Printer jams",
      "[SUP-1] Did this fix it? Printer jams",
      "[SUP-1] New reply: Printer jams",
    ]);
    expect(res.text).toContain("Back to SUP-1");
  });

  it("shows the team every notice of the ticket, by name", async () => {
    const { app, db } = await lifeWithNotices();
    for (const viewer of [teamActor, adminActor]) {
      const res = await ok(as(app, viewer).get("/tickets/SUP-1/notices"));
      expect(recipients(res.text)).toHaveLength(6);
      expect(noticeCountFor(db, 1, viewer)).toBe(6);
    }
    const res = await ok(as(app, teamActor).get("/tickets/SUP-1/notices"));
    expect(recipients(res.text)).toContain(`To ${customerOne.name}`);
    expect(recipients(res.text)).toContain(`To ${adminActor.name}`);
    expect(noticeCountFor(db, 1, customerOne)).toBe(3);
  });

  it("never shows an internal note or anyone's address", async () => {
    const { app } = await lifeWithNotices();
    for (const viewer of [customerOne, teamActor, adminActor]) {
      const res = await ok(as(app, viewer).get("/tickets/SUP-1/notices"));
      expect(res.text).not.toContain(NOTE_MARKER);
      expect(res.text).not.toContain("@example.com");
    }
  });

  it("cannot be reached for someone else's ticket, by a visitor or by an assistant key", async () => {
    const { app } = await lifeWithNotices();
    const elsewhere = await as(app, customerTwo).get("/tickets/SUP-1/notices");
    const ticketPage = await as(app, customerTwo).get("/tickets/SUP-1");
    expect(elsewhere.status).toBe(404);
    expect(ticketPage.status).toBe(404);
    expect(elsewhere.text).not.toContain("Printer jams");

    const signedOut = await visitor(app).get("/tickets/SUP-1/notices");
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.location).toMatch(/^\/sign-in/);

    // Pages never take an assistant's key, so it is treated as nobody signed in.
    const withKey = await request(app)
      .get("/tickets/SUP-1/notices")
      .set("Authorization", "Bearer sdk_anything");
    expect(withKey.status).toBe(303);
    expect(withKey.text).not.toContain("Did this fix it?");
  });

  it("shows the body as text, never as HTML", async () => {
    const { app, db } = buildTestApp();
    giveAddresses(db);
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Bold <b>title</b>", description: "Some words.", fix_check: "It works" }),
      201,
    );
    await ok(
      as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .send({ kind: "reply", body: "Try <script>alert(1)</script> & see." }),
      201,
    );
    collectNotices(db, WITH_MAIL);
    const res = await ok(as(app, customerOne).get("/tickets/SUP-1/notices"));
    expect(res.text).not.toContain("<script>alert(1)");
    expect(res.text).not.toContain("<b>title</b>");
    const body = parse(res.text).querySelector("article.email .email-body")!;
    expect(body.text).toContain("Try <script>alert(1)</script> & see.");
  });

  it("says when a ticket has no notices yet", async () => {
    const { app } = buildTestApp();
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Printer jams", description: "On page two.", fix_check: "It prints" }),
      201,
    );
    const res = await ok(as(app, customerOne).get("/tickets/SUP-1/notices"));
    expect(res.text).toContain("No emails sent yet.");
  });

  it("is named as its link in More options names it, in its heading and its title", async () => {
    const { app } = await lifeWithNotices();
    const ticket = parse((await ok(as(app, customerOne).get("/tickets/SUP-1"))).text);
    const link = ticket.querySelector('a[href="/tickets/SUP-1/notices"]')!;
    const html = parse((await ok(as(app, customerOne).get("/tickets/SUP-1/notices"))).text);
    expect(html.querySelector("h1")?.text).toBe(link.text);
    expect(html.querySelector("title")?.text).toBe(`${link.text} - Proofdesk`);
    expect(link.text).toBe("Emails sent about this ticket");
  });
});

describe("the state of each notice, in plain words", () => {
  function setState(db: Db, state: string, attempts: number) {
    db.prepare(
      "UPDATE email_outbox SET state = ?, attempts = ?, sent_at = '2026-11-18T12:00:00.000Z'",
    ).run(state, attempts);
  }

  it("reads Sent, Failed after five tries, or waiting", async () => {
    const { app, db } = await lifeWithNotices();
    const page = async () =>
      states((await ok(as(app, customerOne).get("/tickets/SUP-1/notices"))).text);
    expect(await page()).toEqual(Array(3).fill("Waiting to be sent"));
    setState(db, "sent", 1);
    expect(await page()).toEqual(Array(3).fill("Sent"));
    setState(db, "failed", 5);
    expect(await page()).toEqual(Array(3).fill("Failed after five tries"));
  });

  it("reads 'no mail server' on a site without one", async () => {
    const { app } = await lifeWithNotices({ ...WITH_MAIL, mailConfigured: false });
    const res = await ok(as(app, teamActor).get("/tickets/SUP-1/notices"));
    expect(states(res.text)).toEqual(
      Array(6).fill("Not sent: no mail server is set up on this site"),
    );
  });

  it("reads 'the demo sends no email' on the demo", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const settings = { ...notifySettingsOf(config), madeUpPeople: madeUpPeopleOf(config) };
    const [demoCustomer, demoTeam] = DEMO_ACTORS as [Actor, Actor];
    const asDemo = (app: Express, who: Actor) =>
      request.agent(app).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${who.id}`);
    const filed = await ok(
      asDemo(app, demoCustomer)
        .post("/api/tickets")
        .send({ title: "Mail is slow", description: "Very slow.", fix_check: "It is fast" }),
      201,
    );
    const key = filed.body.key as string;
    await ok(asDemo(app, demoTeam).post(`/api/tickets/${key}/take-and-start`));
    await ok(
      asDemo(app, demoTeam)
        .post(`/api/tickets/${key}/entries`)
        .send({ kind: "reply", body: "Looking at it." }),
      201,
    );
    collectNotices(db, settings);
    const res = await ok(asDemo(app, demoCustomer).get(`/tickets/${key}/notices`));
    expect(recipients(res.text)).toEqual(["To You"]);
    expect(states(res.text)).toEqual(["Not sent: the demo sends no email"]);
    expect(res.text).toContain("Looking at it.");
  });
});

describe("the words for a notice kept and not sent", () => {
  it("name the reason for every reason there is", () => {
    for (const reason of Object.values(NOT_SENT_REASONS)) {
      const notice = { state: "not_sent", not_sent_reason: reason, attempts: 0 } as Parameters<
        typeof noticeStateWords
      >[0];
      expect(noticeStateWords(notice)).toMatch(/^Not sent: /);
    }
  });
});

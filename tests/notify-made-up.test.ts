import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE, type Actor } from "../src/server/actor.js";
import type { Db } from "../src/server/db.js";
import { seedDemo } from "../src/server/demo.js";
import {
  collectNotices,
  madeUpPeopleOf,
  NOT_SENT_REASONS,
  type NotifySettings,
} from "../src/server/notify/outbox.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, teamActor } from "./helpers.js";

// The made-up people of the demo and the development entrance never signed in, so they have no
// address. Their notices are still written, never as pending, so a page can show what would
// have been emailed. None of these tests gives anyone a sign-in row.

type Row = {
  ticket_id: number;
  recipient_id: string;
  kind: string;
  address: string;
  body: string;
  state: string;
  not_sent_reason: string | null;
};

function allNotices(db: Db): Row[] {
  return db.prepare("SELECT * FROM email_outbox ORDER BY id").all() as Row[];
}

async function ok(res: Promise<request.Response>, status = 200) {
  const done = await res;
  expect(done.status, done.text).toBe(status);
  return done;
}

describe("notices for the made-up people of the demo", () => {
  const [demoCustomer, demoTeam] = DEMO_ACTORS as [Actor, Actor];
  const asDemo = (app: Express, who: Actor) =>
    request.agent(app).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${who.id}`);

  it("are written as not sent, with the demo's reason and no address", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const settings: NotifySettings = {
      ticketPrefix: config.ticketPrefix,
      siteUrl: "https://demo.test",
      demo: true,
      mailConfigured: false,
      madeUpPeople: madeUpPeopleOf(config),
    };
    // A fresh demo database collects the samples' history too, so they show notices as well.
    collectNotices(db, settings);
    const fromSamples = allNotices(db).length;
    expect(fromSamples).toBeGreaterThan(0);

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
    await ok(
      asDemo(app, demoTeam)
        .put(`/api/tickets/${key}/change-link`)
        .send({ change_url: "https://example.com/change/1" }),
    );
    const asked = await ok(
      asDemo(app, demoTeam)
        .post(`/api/tickets/${key}/ready`)
        .send({ try_url: "https://example.com/try", tried: "Sent ten.", result: "Fast." }),
    );
    await ok(
      asDemo(app, demoCustomer).post(`/api/tickets/${key}/answer`).send({
        fixed: "no",
        comment: "Still slow.",
        ready_token: asked.body.ready_token,
      }),
    );
    collectNotices(db, settings);

    const mine = allNotices(db).slice(fromSamples);
    expect(mine.map((n) => `${n.recipient_id} ${n.kind}`)).toEqual([
      "demo-customer team_replied",
      "demo-customer asked_to_check",
      "demo-team customer_said_no",
    ]);
    for (const notice of allNotices(db)) {
      expect(notice.state).toBe("not_sent");
      expect(notice.not_sent_reason).toBe(NOT_SENT_REASONS.demo);
      expect(notice.address).toBe("");
    }
    // The made-up people are named as the demo names them.
    expect(mine[0]!.body).toContain("Hello Demo Customer,");
    expect(mine[2]!.body).toContain("Demo Customer says ticket");
  });
});

describe("notices for the made-up people of the development entrance", () => {
  it("are written as not sent, even when a mail server is set up", async () => {
    const { app, db, config } = buildTestApp();
    const settings: NotifySettings = {
      ticketPrefix: config.ticketPrefix,
      siteUrl: "https://desk.test",
      demo: false,
      mailConfigured: true,
      madeUpPeople: madeUpPeopleOf(config),
    };
    await ok(
      as(app, customerOne)
        .post("/api/tickets")
        .send({ title: "Printer jams", description: "On page two." }),
      201,
    );
    await ok(as(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    await ok(
      as(app, teamActor).post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "On it." }),
      201,
    );
    collectNotices(db, settings);
    const notices = allNotices(db);
    expect(notices.map((n) => `${n.recipient_id} ${n.kind}`)).toEqual([
      "dev-customer-1 team_replied",
    ]);
    expect(notices[0]!.state).toBe("not_sent");
    expect(notices[0]!.not_sent_reason).toBe(NOT_SENT_REASONS.madeUp);
    expect(notices[0]!.body).toContain("Hello Customer One,");
  });

  it("name only the people this server offers", () => {
    const dev = buildTestApp().config;
    expect(madeUpPeopleOf(dev).map((p) => p.id)).toEqual([
      "dev-customer-1",
      "dev-customer-2",
      "dev-team-1",
      "dev-admin-1",
    ]);
    const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" }).config;
    expect(madeUpPeopleOf(demo).map((p) => p.id)).toEqual([
      "demo-customer",
      "demo-team",
      "demo-admin",
      "demo-customer-2",
      "demo-customer-3",
    ]);
    // A real site has nobody made up.
    expect(madeUpPeopleOf(buildTestApp({ NODE_ENV: "production" }).config)).toEqual([]);
  });
});

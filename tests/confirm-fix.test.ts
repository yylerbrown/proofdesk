import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { allowedActions } from "../src/server/tickets/allowed-actions.js";
import type { Ticket } from "../src/server/tickets/types.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  handToAgent,
  teamActor,
  visitor,
} from "./helpers.js";

// The customer may confirm a ticket the team resolved as fixed. Their Yes turns "Resolved by
// the team: Fixed" into "Customer confirmed", the same state a Yes to the question leaves.
// Saying nothing leaves it resolved by the team.

const filed = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

/** SUP-1 filed by the customer, taken and started by the team member, then resolved. */
async function resolvedAs(reason: string, extra: object = {}) {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const resolved = await as(built.app, teamActor)
    .post("/api/tickets/SUP-1/resolve")
    .send({ reason, ...extra });
  expect(resolved.status, resolved.text).toBe(200);
  return built;
}

const confirm = (app: Express, body: object = {}) =>
  as(app, customerOne).post("/api/tickets/SUP-1/confirm").send(body);

async function eventTypes(app: Express): Promise<string[]> {
  const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
  return events.map((event) => event.type);
}

describe("the customer confirming a ticket the team marked fixed", () => {
  it("makes it customer confirmed, with one history line", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    const res = await confirm(app);
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolution).toMatchObject({ by: "customer", label: "Customer confirmed" });
    const answered = (await eventTypes(app)).filter((type) => type === "customer_answered");
    expect(answered).toHaveLength(1);
    const history = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    expect(history).toContain("Customer confirmed");
  });

  it("changes nothing when pressed a second time", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    await confirm(app);
    const before = await eventTypes(app);
    const again = await confirm(app);
    expect(again.status).toBe(200);
    expect(again.body.resolution.by).toBe("customer");
    expect(await eventTypes(app)).toEqual(before);
  });

  it("shows the check mark on the list, and the team can no longer reopen it", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    await confirm(app);
    const list = parse((await as(app, teamActor).get("/tickets?status=all")).text);
    expect(list.querySelector(".confirmed-mark")).not.toBeNull();
    const reopened = await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Undo." });
    expect([reopened.status, reopened.body.error.code]).toEqual([403, "customer_confirmed"]);
  });

  it("is refused for the other four reasons, in one plain sentence", async () => {
    const reasons = [
      { reason: "wont_fix" },
      { reason: "cannot_reproduce" },
      { reason: "other", note: "Handled by phone." },
      { reason: "duplicate", duplicate_of: "SUP-2" },
    ];
    for (const { reason, ...extra } of reasons) {
      const built = buildTestApp();
      await as(built.app, customerOne).post("/api/tickets").send(filed);
      await as(built.app, customerOne).post("/api/tickets").send(filed);
      await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
      const resolved = await as(built.app, teamActor)
        .post("/api/tickets/SUP-1/resolve")
        .send({ reason, ...extra });
      expect(resolved.status, resolved.text).toBe(200);
      const res = await confirm(built.app);
      expect(res.status, reason).toBe(409);
      expect(res.body.error.message).toBe("Ticket SUP-1 is not waiting for your answer.");
      const ticket = (await admin(built.app).get("/api/tickets/SUP-1")).body;
      expect(ticket.resolution.by, reason).toBe("team");
    }
  });

  it("is refused while the ticket is still open", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const res = await confirm(app);
    expect(res.status).toBe(409);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("is never for the team, an admin or another customer", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    for (const who of [teamActor, adminActor]) {
      const res = await as(app, who).post("/api/tickets/SUP-1/confirm").send({});
      expect(res.status, who.id).toBe(403);
    }
    const stranger = await as(app, customerTwo).post("/api/tickets/SUP-1/confirm").send({});
    expect(stranger.status).toBe(404);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.resolution.by).toBe("team");
  });

  it("is never for an assistant, whatever its key holds", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const made = await admin(app)
      .post("/connections")
      .type("form")
      .send({
        name: "Helper",
        scopes: ["read_tickets", "read_notes", "write_notes", "attach_evidence", "link_changes"],
      });
    const key = keyOnPage(made.text);
    await handToAgent(app, "SUP-1", key);
    // While the ticket is handed to it, the assistant may read it, and still may not confirm.
    const handed = await request(app)
      .post("/api/tickets/SUP-1/confirm")
      .set("Authorization", `Bearer ${key}`)
      .send({});
    expect(handed.status).toBe(403);
    await admin(app).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });
    const res = await request(app)
      .post("/api/tickets/SUP-1/confirm")
      .set("Authorization", `Bearer ${key}`)
      .send({});
    expect([403, 404]).toContain(res.status);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.resolution.by).toBe("team");
  });

  it("is hidden from the customer once the ticket is archived", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    await as(app, teamActor).post("/api/tickets/SUP-1/archive");
    const res = await confirm(app);
    expect(res.status).toBe(404);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.resolution.by).toBe("team");
  });

  it("is refused from a page opened before the ticket changed, and changes nothing", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    const seen = (await admin(app).get("/api/tickets/SUP-1")).body.version as number;
    await as(app, teamActor).post("/api/tickets/SUP-1/reopen").send({ reason: "Not yet." });
    await as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });
    const res = await confirm(app, { expected_version: seen });
    expect([res.status, res.body.error.code]).toEqual([409, "ticket_changed"]);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.resolution.by).toBe("team");
  });

  it("is offered to the filer only, on a ticket the team marked fixed", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body as Ticket;
    expect(allowedActions(ticket, customerOne).confirmFix).toBe(true);
    for (const who of [teamActor, adminActor, customerTwo]) {
      expect(allowedActions(ticket, who).confirmFix, who.id).toBe(false);
    }
    await confirm(app);
    const confirmed = (await admin(app).get("/api/tickets/SUP-1")).body as Ticket;
    expect(allowedActions(confirmed, customerOne).confirmFix).toBe(false);
  });

  it("is not offered for another reason", async () => {
    const { app } = await resolvedAs("wont_fix");
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body as Ticket;
    expect(allowedActions(ticket, customerOne).confirmFix).toBe(false);
  });
});

describe("saying nothing after the team marked it fixed", () => {
  it("leaves it resolved by the team, not confirmed", async () => {
    const { app } = await resolvedAs("fixed_no_reply", { note: "version 4.2.1" });
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.status).toBe("resolved");
    expect(ticket.resolution).toMatchObject({
      by: "team",
      reason: "fixed_no_reply",
      note: "version 4.2.1",
    });
    expect(await eventTypes(app)).not.toContain("customer_answered");
  });
});

describe("the confirm form on the ticket page", () => {
  it("confirms and comes back to the ticket with its thank-you line", async () => {
    const { app } = await resolvedAs("fixed_no_reply");
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    const posted = await as(app, customerOne)
      .post("/tickets/SUP-1/confirm")
      .set(FROM_THIS_SITE)
      .type("form")
      .send({ expected_version: String(ticket.version) });
    expect(posted.status).toBe(303);
    expect(posted.headers.location).toBe("/tickets/SUP-1");
    const saved = String([posted.headers["set-cookie"]].flat()[0]).split(";")[0]!;
    const page = await visitor(app)
      .get("/tickets/SUP-1")
      .set("Cookie", `${DEV_COOKIE}=${customerOne.id}; ${saved}`);
    expect(page.text).toContain("Thank you. The ticket is resolved.");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.resolution.by).toBe("customer");
  });
});

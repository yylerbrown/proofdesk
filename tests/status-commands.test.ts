import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  resolveTicket,
  teamActor,
} from "./helpers.js";

// The status moves only by the workflow's own steps: the owner starts work, only the
// customer's Yes resolves, and only the customer who filed a resolved ticket reopens it.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function issue(app: Express, scopes: string[]) {
  const res = await admin(app).post("/connections").type("form").send({ name: "Helper", scopes });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

const reread = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

describe("after the customer's Yes", () => {
  it("nobody moves the ticket by changing its status; the filer reopens it, and the Yes stays", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    expect((await reread(app)).status).toBe("resolved");

    const key = await issue(app, [...AGENT_SCOPES]);
    for (const [who, send] of [
      ["team", (s: string) => as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: s })],
      ["admin", (s: string) => admin(app).patch("/api/tickets/SUP-1").send({ status: s })],
      [
        "agent",
        (s: string) =>
          request(app)
            .patch("/api/tickets/SUP-1")
            .set("Authorization", `Bearer ${key}`)
            .send({ status: s }),
      ],
    ] as const) {
      for (const status of ["new", "in_progress"]) {
        const res = await send(status);
        expect(res.status, `${who} → ${status}`).toBeGreaterThanOrEqual(403);
        expect((await reread(app)).status, `${who} → ${status}`).toBe("resolved");
      }
    }
    // No one but the customer who filed it can reopen it: not another customer, the team or
    // an admin.
    expect(
      (await as(app, customerTwo).post("/api/tickets/SUP-1/reopen").send({ reason: "x" })).status,
    ).toBe(404);
    expect(
      (await as(app, teamActor).post("/api/tickets/SUP-1/reopen").send({ reason: "x" })).status,
    ).toBe(403);
    expect((await admin(app).post("/api/tickets/SUP-1/reopen").send({ reason: "x" })).status).toBe(
      403,
    );

    const reopened = await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It jams again on page two." });
    expect(reopened.status).toBe(200);
    const after = await reread(app);
    // Back with its owner, in progress, and the earlier Yes still in the history.
    expect(after).toMatchObject({ status: "in_progress", owner_name: "Admin" });
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as {
      type: string;
      data: { fixed?: boolean };
    }[];
    expect(
      events.filter((e) => e.type === "customer_answered" && e.data.fixed === true),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "reopened",
      data: { reason: "It jams again on page two." },
    });
    const entries = (await as(app, customerOne).get("/api/tickets/SUP-1/entries")).body as {
      body: string;
    }[];
    expect(entries.at(-1)!.body).toBe("It jams again on page two.");
    // Reopening twice is refused: it is open now.
    expect(
      (await as(app, customerOne).post("/api/tickets/SUP-1/reopen").send({ reason: "again" }))
        .status,
    ).toBe(409);
  });

  it("returns a reopened ticket with no owner to the inbox", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    // A ticket resolved before owners were required has none. A resolved ticket cannot be
    // released, so the row is set as an old one would be.
    expect((await admin(app).post("/api/tickets/SUP-1/release")).status).toBe(409);
    db.prepare("UPDATE tickets SET owner_id = NULL, owner_name = NULL").run();
    await as(app, customerOne).post("/api/tickets/SUP-1/reopen").send({ reason: "Again." });
    expect(await reread(app)).toMatchObject({ status: "new", owner_name: null });
  });

  it("offers the customer Still happening on the page, and needs their words", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(page.querySelector("#reopen summary")?.text).toBe("Still happening?");
    expect(
      parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector("#reopen"),
    ).toBeNull();
    const empty = await as(app, customerOne)
      .post("/tickets/SUP-1/reopen")
      .type("form")
      .send({ reason: "" });
    expect(empty.status).toBe(400);
    expect(parse(empty.text).querySelector("#reopen-error")?.text).toMatch(/happening again/);
    const done = await as(app, customerOne)
      .post("/tickets/SUP-1/reopen")
      .type("form")
      .send({ reason: "Jams again." });
    expect(done.status).toBe(303);
  });
});

describe("starting work", () => {
  it("is for the ticket's owner only", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const other = await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe("not_owner");
    expect((await reread(app)).status).toBe("new");
    const owner = await as(app, teamActor)
      .patch("/api/tickets/SUP-1")
      .send({ status: "in_progress" });
    expect(owner.status).toBe(200);
    expect((await reread(app)).status).toBe("in_progress");
  });

  it("can be one step with taking, only for an unowned ticket", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const started = await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    expect(started.status).toBe(200);
    expect(await reread(app)).toMatchObject({ status: "in_progress", owner_name: "Team Member" });
    await admin(app).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-2/take");
    const taken = await admin(app).post("/api/tickets/SUP-2/take-and-start");
    expect(taken.body.error.code).toBe("already_owned");
  });

  it("puts Take under the status, as the next action, and offers Start work only to the owner", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const unowned = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const panel = unowned.querySelector("aside.ticket-panel")!;
    expect(panel.querySelector("h2")?.text).toBe("Owner");
    expect(unowned.querySelector(".next-action button")?.text.trim()).toBe(
      "Take ticket and start work",
    );
    // Taking without starting work is a secondary action, in More.
    expect(panel.querySelector("details.more form[action$='/take'] button")?.text).toBe(
      "Take this ticket",
    );
    // The panel's Start work takes the ticket too, so it is the same one step as the top.
    expect(panel.querySelector("form[action$='/status']")).toBeNull();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const mine = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(mine.querySelector(".next-action form[action$='/status'] button")?.text).toBe(
      "Start work",
    );
    const theirs = parse((await admin(app).get("/tickets/SUP-1")).text);
    expect(theirs.querySelector("form[action$='/status']")).toBeNull();
  });
});

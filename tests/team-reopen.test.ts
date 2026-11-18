import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { TOOL_ACTIONS } from "../src/server/mcp.js";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  resolveTicket,
  teamActor,
} from "./helpers.js";
import type { Actor } from "../src/server/actor.js";

// A resolution by the team can be a slip of the hand, so the ticket's owner or an admin may
// reopen a ticket the team resolved, with a reason that goes into the history. A ticket the
// customer confirmed with their Yes stays the customer's to reopen. An agent never reopens.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };
const why = { reason: "Resolved by mistake, the fix is not out yet." };

/** SUP-1, filed by the customer, taken and started by `owner`, then resolved by the team. */
async function teamResolved(owner: Actor = teamActor) {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, owner).post("/api/tickets/SUP-1/take-and-start");
  const resolved = await as(built.app, owner)
    .post("/api/tickets/SUP-1/resolve")
    .send({ reason: "wont_fix" });
  expect(resolved.status).toBe(200);
  return built;
}

const reopen = (app: Express, who: Actor, body: object = why) =>
  as(app, who).post("/api/tickets/SUP-1/reopen").send(body);

const reread = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

const offersReopen = async (app: Express, who: Actor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text).querySelector("#reopen") !== null;

describe("the team reopening a ticket the team resolved", () => {
  it("is open to its owner: back in progress with them, and the history says who and why", async () => {
    const { app } = await teamResolved();
    expect(await offersReopen(app, teamActor)).toBe(true);
    const entriesBefore = (await admin(app).get("/api/tickets/SUP-1/entries")).body.length;

    const res = await reopen(app, teamActor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "in_progress",
      owner_name: "Team Member",
      resolution: null,
    });
    expect(await reread(app)).toMatchObject({ status: "in_progress", resolution: null });

    // The customer sees the entry in the history. Nothing is posted as a reply to them.
    const events = (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body as {
      type: string;
      actor_name: string;
      data: object;
    }[];
    expect(events.at(-1)).toMatchObject({
      type: "reopened_by_team",
      data: { reason: why.reason, to: "in_progress" },
    });
    expect((await admin(app).get("/api/tickets/SUP-1/entries")).body).toHaveLength(entriesBefore);
    const page = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    expect(page).toContain(`Reopened by the team: ${why.reason}`);
  });

  it("needs a reason, as the customer's reopen does", async () => {
    const { app } = await teamResolved();
    const empty = await reopen(app, teamActor, { reason: "  " });
    expect(empty.status).toBe(400);
    expect(Object.keys(empty.body.error.fields)).toEqual(["reason"]);
    expect((await reread(app)).status).toBe("resolved");
  });

  it("is open to an admin who does not own it, and an unowned ticket goes back to the inbox", async () => {
    const { app } = await teamResolved();
    expect(await offersReopen(app, adminActor)).toBe(true);
    expect((await reopen(app, adminActor)).status).toBe(200);
    expect(await reread(app)).toMatchObject({ status: "in_progress", owner_name: "Team Member" });

    const second = buildTestApp().app;
    await as(second, customerOne).post("/api/tickets").send(valid);
    await admin(second).post("/api/tickets/SUP-1/resolve").send({ reason: "cannot_reproduce" });
    expect((await reopen(second, adminActor)).status).toBe(200);
    expect(await reread(second)).toMatchObject({ status: "new", owner_name: null });
  });

  it("is refused to a team member who does not own the ticket", async () => {
    const { app } = await teamResolved(adminActor);
    expect(await offersReopen(app, teamActor)).toBe(false);
    const res = await reopen(app, teamActor);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("not_owner");
    // Who may reopen is checked before the reason, so an empty form gets the same refusal.
    expect((await reopen(app, teamActor, {})).body.error.code).toBe("not_owner");
    expect((await reread(app)).status).toBe("resolved");
  });

  it("is refused to an assistant, even one holding every scope", async () => {
    const { app } = await teamResolved();
    const issued = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
    const key = parse(issued.text).querySelector("input.key")!.getAttribute("value")!;
    const res = await request(app)
      .post("/api/tickets/SUP-1/reopen")
      .set("Authorization", `Bearer ${key}`)
      .send(why);
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(TOOL_ACTIONS.map((row) => row.name)).not.toContain("reopen");
    expect((await reread(app)).status).toBe("resolved");
  });

  it("still lets the customer reopen it, with their words as a reply", async () => {
    const { app } = await teamResolved();
    expect(await offersReopen(app, customerOne)).toBe(true);
    expect((await reopen(app, customerOne, { reason: "It jams again." })).status).toBe(200);
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.at(-1)!.type).toBe("reopened");
  });
});

describe("a ticket the customer confirmed with their Yes", () => {
  it("is never reopened by the team, and the refusal says why; the customer still can", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    // The admin owns it here, so the refusal cannot be about ownership.
    await resolveTicket(app, "SUP-1", customerOne);
    for (const who of [adminActor, teamActor]) {
      expect(await offersReopen(app, who), who.name).toBe(false);
      const res = await reopen(app, who);
      expect(res.status, who.name).toBe(403);
      expect(res.body.error.code, who.name).toBe("customer_confirmed");
      expect(res.body.error.message).toMatch(/customer confirmed .* Only they can reopen it/);
      expect((await reopen(app, who, {})).body.error.code, who.name).toBe("customer_confirmed");
    }
    expect((await reread(app)).status).toBe("resolved");
    expect(await offersReopen(app, customerOne)).toBe(true);
    expect((await reopen(app, customerOne, { reason: "It jams again." })).status).toBe(200);
  });
});

describe("the API description of reopen", () => {
  it("says who may reopen which kind of resolution", async () => {
    const { app } = buildTestApp();
    const spec = (await request(app).get("/api/openapi.json")).body;
    const operation = spec.paths["/tickets/{key}/reopen"].post;
    expect(operation.summary).toMatch(/owner or an admin can reopen one the team resolved/);
    expect(operation.summary).toMatch(/never one the customer confirmed/);
    expect(operation.description).toMatch(/when the team resolved it, its owner or an admin/);
    expect(operation.description).toContain("Agents: people only.");
  });
});

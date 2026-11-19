import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { ACTIONS } from "../src/server/api/actions.js";
import { TOOL_ACTIONS } from "../src/server/mcp.js";
import { CAPABILITIES } from "../src/server/permissions.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  handToAgent,
  teamActor,
  visitor,
} from "./helpers.js";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";

// Sending an In Progress ticket back to New: its owner or an admin may, and the ticket then has
// no owner, so anyone on the team can take it. An open question to the customer is withdrawn
// with its own history entry, and an assistant's work on it ends. An assistant never does it.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

/** SUP-1, filed by the customer, taken and started by `owner`. */
async function started(owner: Actor = teamActor) {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, owner).post("/api/tickets/SUP-1/take-and-start").expect(200);
  return built;
}

const toNew = (app: Express, who: Actor) =>
  as(app, who).patch("/api/tickets/SUP-1").send({ status: "new" });

const history = async (app: Express) =>
  (
    (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string; data: unknown }[]
  ).map((event) => event.type);

describe("returning a ticket to New", () => {
  it("is open to its owner: New, with no owner, and the history says who did it", async () => {
    const { app } = await started();
    const res = await toNew(app, teamActor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "new", owner_id: null, owner_name: null });
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as {
      type: string;
      actor: string;
      data: unknown;
    }[];
    const last = events.at(-1)!;
    expect(last).toMatchObject({
      type: "status_changed",
      actor: teamActor.id,
      data: { from: "in_progress", to: "new" },
    });
    expect(events.at(-2)).toMatchObject({ type: "owner_changed", data: { to: null } });
    // Back in the inbox: anyone on the team can take it and start again.
    await as(app, adminActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
  });

  it("is open to an admin on someone else's ticket, and closed to another team member", async () => {
    const { app } = await started(adminActor);
    const refused = await toNew(app, teamActor);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(
      "Only Admin, who owns ticket SUP-1, or an admin can return it to New.",
    );
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");

    const { app: other } = await started(teamActor);
    expect((await toNew(other, adminActor)).status).toBe(200);
  });

  it("changes nothing on a ticket that is already New, whoever owns it", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await admin(app).post("/api/tickets/SUP-1/take").expect(200);
    const before = (await admin(app).get("/api/tickets/SUP-1")).body;
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body.length;
    const res = await toNew(app, teamActor).expect(200);
    expect(res.body).toMatchObject({ status: "new", owner_name: "Admin" });
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(events);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.updated_at).toBe(before.updated_at);
  });

  it("withdraws an open question with its own history entry", async () => {
    const { app } = await started();
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({}).expect(200);
    await toNew(app, teamActor).expect(200);
    const types = await history(app);
    expect(types.slice(-3)).toEqual(["question_withdrawn", "owner_changed", "status_changed"]);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.ready_at).toBeNull();
  });

  it("ends an assistant's work on the ticket, as a hand-off does", async () => {
    const { app } = await started();
    const issued = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
    const key = keyOnPage(issued.text);
    await handToAgent(app, "SUP-1", key);
    await toNew(app, teamActor).expect(200);
    expect(await history(app)).toContain("agent_handoff_ended");
    const read = await request(app).get("/api/tickets/SUP-1").set("Authorization", `Bearer ${key}`);
    expect(read.status).toBe(404);
  });

  it("is never an assistant's move, through the API or a tool", async () => {
    const { app } = await started();
    const issued = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
    const key = keyOnPage(issued.text);
    await handToAgent(app, "SUP-1", key);
    const res = await request(app)
      .patch("/api/tickets/SUP-1")
      .set("Authorization", `Bearer ${key}`)
      .send({ status: "new" });
    expect(res.status).toBe(403);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
    expect(CAPABILITIES.change_status.agent).toBe("people_only");
    expect(TOOL_ACTIONS.map((row) => row.name)).not.toContain("change_status");
  });

  it("is said in the API's own description", () => {
    const row = ACTIONS.find((action) => action.name === "change_status")!;
    expect(row.summary).toMatch(/back to new/);
    expect(CAPABILITIES.change_status.people).toMatch(/back to New/);
  });

  it("is one press on the ticket page, and says what happened", async () => {
    const { app } = await started();
    const browser = visitor(app).set("Cookie", `${DEV_COOKIE}=${teamActor.id}`);
    const res = await browser.post("/tickets/SUP-1/status").type("form").send({ status: "new" });
    expect(res.status).toBe(303);
    const page = await visitor(app)
      .set("Cookie", [`${DEV_COOKIE}=${teamActor.id}`, ...[res.headers["set-cookie"]].flat()])
      .get("/tickets/SUP-1");
    expect(parse(page.text).querySelector("p.saved")?.text.trim()).toBe(
      "Back to New, with no owner. Anyone on the team can take it.",
    );
  });
});

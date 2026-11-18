import { parse } from "node-html-parser";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import { describe, expect, it } from "vitest";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };

async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

describe("a named human owner", () => {
  it("starts with nobody, and a team member takes the ticket", async () => {
    const { app } = await setup();
    const before = await admin(app).get("/api/tickets/SUP-1");
    expect(before.body).toMatchObject({ owner_id: null, owner_name: null });

    const taken = await as(app, teamActor).post("/api/tickets/SUP-1/take");
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ owner_id: teamActor.id, owner_name: "Team Member" });

    const history = await admin(app).get("/api/tickets/SUP-1/events");
    expect(history.body.at(-1)).toMatchObject({
      type: "owner_changed",
      actor: teamActor.id,
      data: { from: null, to: "Team Member" },
    });
  });

  it("passes from one owner to another only by a hand-off, and says so in the history", async () => {
    const { app } = await setup();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const taken = await admin(app).post("/api/tickets/SUP-1/take");
    expect(taken.body.error.code).toBe("already_owned");
    const handed = await as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    expect(handed.body.owner_name).toBe("Admin");
    const history = await admin(app).get("/api/tickets/SUP-1/events");
    expect(history.body.at(-1).data).toEqual({ from: "Team Member", to: "Admin" });
    expect(history.body.at(-1).actor).toBe("dev-team-1");
  });

  it("writes nothing when the owner takes their own ticket again", async () => {
    const { app } = await setup();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(2);
  });

  it("refuses In Progress until someone owns the ticket", async () => {
    const { app } = await setup();
    const refused = await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toEqual({
      code: "needs_owner",
      message: "Take ticket SUP-1 before moving it to In Progress.",
      hint: "Take the ticket first (POST .../take), then change the status.",
      retry: false,
    });
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("new");

    await admin(app).post("/api/tickets/SUP-1/take");
    const ok = await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    expect(ok.status).toBe(200);
  });

  it("keeps an owner while the ticket is in progress, and releases it after", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-1/take");
    await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    const refused = await admin(app).post("/api/tickets/SUP-1/release");
    expect(refused.status).toBe(409);
    // Its own code and hint: the one for "take it first" would send the owner the wrong way.
    expect(refused.body.error).toEqual({
      code: "keeps_owner",
      message: "Ticket SUP-1 is in progress, so it must keep an owner. Someone else can take it.",
      hint: "Work has started, so the ticket keeps an owner. Hand it to a team member instead (POST .../hand-off).",
      retry: false,
    });
    expect((await admin(app).get("/api/tickets/SUP-1")).body.owner_name).toBe("Admin");

    // Started work does not go back to New, so it cannot be released that way either.
    const back = await admin(app).patch("/api/tickets/SUP-1").send({ status: "new" });
    expect(back.body.error.code).toBe("cannot_return_to_new");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.owner_name).toBe("Admin");
  });

  it("has the database refuse an in-progress ticket without an owner, whatever the code does", async () => {
    const { app, db } = await setup();
    await admin(app).post("/api/tickets/SUP-1/take");
    await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    expect(() => db.prepare("UPDATE tickets SET owner_id = NULL WHERE id = 1").run()).toThrow(
      /must have an owner/,
    );
    expect(() =>
      db.prepare("UPDATE tickets SET status = 'in_progress', owner_id = NULL WHERE id = 1").run(),
    ).toThrow(/must have an owner/);
  });

  it("is never an agent", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(valid, adminActor);
    const agent = {
      id: "helper-1",
      kind: "agent" as const,
      role: "team" as const,
      name: "Helper",
      scopes: [...AGENT_SCOPES],
    };
    expect(() => service.takeTicket("SUP-1", agent)).toThrow(/not allowed/);
    expect(service.getTicket("SUP-1", adminActor).owner_id).toBeNull();
  });

  it("is never the customer", async () => {
    const { app } = await setup();
    expect((await as(app, customerOne).post("/api/tickets/SUP-1/take")).status).toBe(403);
    expect((await as(app, customerOne).post("/api/tickets/SUP-1/release")).status).toBe(403);
  });

  it("does not change on an archived ticket", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-1/archive");
    expect((await admin(app).post("/api/tickets/SUP-1/take")).status).toBe(409);
  });
});

describe("the owner on the ticket page", () => {
  it("shows the owner to everyone and the buttons to the team only", async () => {
    const { app } = await setup();
    const unowned = await as(app, teamActor).get("/tickets/SUP-1");
    expect(unowned.text).toContain("<p>Unassigned</p>");
    expect(unowned.text).toContain("Take this ticket");

    const taken = await as(app, teamActor).post("/tickets/SUP-1/take");
    expect(taken.status).toBe(303);
    const page = await as(app, teamActor).get("/tickets/SUP-1");
    expect(page.text).toContain("<p>Team Member</p>");
    expect(page.text).toContain("Release it");
    expect(page.text).not.toContain("Take this ticket");
    expect(page.text).toContain("<td>Owner: Team Member</td>");

    // An admin may hand it on, but not take it over.
    const adminPage = (await admin(app).get("/tickets/SUP-1")).text;
    expect(adminPage).toContain("Hand off to…");
    expect(adminPage).not.toContain("Take this ticket");

    // A customer has no team panel: the owner is in the line under the title.
    const customer = await as(app, customerOne).get("/tickets/SUP-1");
    expect(parse(customer.text).querySelector("hgroup .meta")?.text).toContain("Owner Team Member");
    expect(customer.text).not.toContain("/take");
  });

  it("explains on the ticket itself why In Progress needs an owner", async () => {
    const { app } = await setup();
    const reason = await refusedBackToTicket(admin(app), "/tickets/SUP-1/status", {
      status: "in_progress",
    });
    expect(reason).toBe("Take ticket SUP-1 before moving it to In Progress.");
  });
});

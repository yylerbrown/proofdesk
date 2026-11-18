import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Take is for the inbox; a ticket someone owns passes on only by a hand-off from its owner or
// an admin, checked against the owner the form was made for.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};
const reread = async (app: Express) => (await admin(app).get("/api/tickets/SUP-1")).body;

async function filed(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
}

describe("taking", () => {
  it("gives the ticket one owner: a second take is refused", async () => {
    const { app } = buildTestApp();
    await filed(app);
    const [first, second] = [
      await as(app, teamActor).post("/api/tickets/SUP-1/take"),
      await admin(app).post("/api/tickets/SUP-1/take"),
    ];
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already_owned");
    expect((await reread(app)).owner_name).toBe("Team Member");
  });
});

describe("releasing", () => {
  it("is for the owner of a New ticket only", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const other = await admin(app).post("/api/tickets/SUP-1/release");
    expect(other.status).toBe(403);
    expect((await reread(app)).owner_name).toBe("Team Member");
    const own = await as(app, teamActor).post("/api/tickets/SUP-1/release");
    expect(own.body.owner_name).toBeNull();
  });
});

describe("handing off", () => {
  it("moves the ticket straight from its owner to another team member", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const res = await as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    expect(res.status).toBe(200);
    expect(await reread(app)).toMatchObject({ owner_name: "Admin", status: "in_progress" });
  });

  it("refuses a hand-off made from an old page", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    // The admin hands it back, on a page that still thinks Team Member owns it.
    const stale = await admin(app)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-team-1", expected_owner: "dev-team-1" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("owner_changed");
    expect((await reread(app)).owner_name).toBe("Admin");
  });

  it("is for the owner or an admin, to a team member only", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await admin(app).post("/api/tickets/SUP-1/take");
    const team = await as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-team-1", expected_owner: "dev-admin-1" });
    expect(team.status).toBe(403);
    for (const to of ["dev-customer-1", "connection-1", "nobody"]) {
      const res = await admin(app)
        .post("/api/tickets/SUP-1/hand-off")
        .send({ to, expected_owner: "dev-admin-1" });
      expect(res.status, to).toBe(400);
    }
    expect((await reread(app)).owner_name).toBe("Admin");
    // An admin may hand on someone else's ticket.
    await admin(app)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-team-1", expected_owner: "dev-admin-1" });
    const again = await admin(app)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    expect(again.status).toBe(200);
  });

  it("withdraws an open question: the new owner asks again", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const asked = await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/t", tried: "Printed it.", result: "Fine." });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/hand-off")
      .send({ to: "dev-admin-1", expected_owner: "dev-team-1" });
    expect((await reread(app)).ready_at).toBeNull();
    const late = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: asked.body.ready_token });
    expect(late.status).toBe(409);
  });

  it("is offered on the page to the owner, listing the other team members", async () => {
    const { app } = buildTestApp();
    await filed(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const options = page.querySelectorAll("form[action$='/hand-off'] option").map((o) => o.text);
    expect(options).toEqual(["Admin"]);
    expect(
      parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
        "form[action$='/hand-off']",
      ),
    ).toBeNull();
  });
});

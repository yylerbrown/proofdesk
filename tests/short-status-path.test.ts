import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Taking a ticket to Resolved needs only the basics. After taking it, its owner asks the customer
// "Did this fix it?" in one press: a change link, a page to try, what was tried, what happened
// and evidence are optional. A team member can also resolve a New ticket nobody owns yet, with a
// reason, and becomes its owner as part of that, in the history.

const filed = { title: "Printer jams", description: "It jams on page two." };

async function inProgress() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return built;
}

describe("asking the customer to verify", () => {
  it("takes a request with no body at all on the JSON API", async () => {
    const { app } = await inProgress();
    const res = await as(app, teamActor).post("/api/tickets/SUP-1/ready");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ waiting_on: "customer", change_url: null, try_url: null });
    expect(res.body.ask).toMatchObject({ tried: null, result: null, response_to_no: null });
  });

  it("is described with every field optional in the API's own description", async () => {
    const { app } = buildTestApp();
    const doc = (await request(app).get("/api/openapi.json")).body;
    const ask = doc.paths["/tickets/{key}/ready"].post;
    expect(ask.summary).toMatch(/Every field is optional/);
    const body = ask.requestBody.content["application/json"].schema;
    const schema = body.$ref ? doc.components.schemas[body.$ref.split("/").pop()] : body;
    expect(schema.required ?? []).toEqual([]);
  });

  it("shows the customer only what the owner gave, and the plain question when nothing was", async () => {
    const { app } = await inProgress();
    await as(app, teamActor).post("/tickets/SUP-1/ready");
    const plain = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    )!;
    expect(plain.querySelector("p")?.text).toBe("The team says it is fixed. Please check it.");
    expect(plain.text).not.toMatch(/tried:|What happened/);
  });

  it("is still refused to anyone but the owner, and before work starts", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const early = await as(app, teamActor).post("/api/tickets/SUP-1/ready");
    expect([early.status, early.body.error.code]).toEqual([409, "not_in_progress"]);
    await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    const other = await admin(app).post("/api/tickets/SUP-1/ready");
    expect([other.status, other.body.error.code]).toEqual([403, "not_owner"]);
  });
});

describe("resolving a New ticket nobody owns", () => {
  it("is offered to a team member, makes them its owner in the history, and lets them reopen it", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const before = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(before.querySelector("details.resolve form")?.getAttribute("action")).toBe(
      "/tickets/SUP-1/resolve",
    );

    const done = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "cannot_reproduce", duplicate_of: "", note: "" });
    expect([done.status, done.headers.location]).toEqual([303, "/tickets/SUP-1"]);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "resolved", owner_name: "Team Member" });
    expect(ticket.resolution.label).toBe("Resolved by the team: Cannot reproduce");

    // The history shows who became the owner, right before the resolution.
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const what = page
      .querySelectorAll("details.history tbody tr")
      .map((row) => row.querySelectorAll("td")[1]!.text);
    const owned = what.indexOf("Owner: Team Member");
    expect(owned).toBeGreaterThanOrEqual(0);
    expect(what[owned + 1]).toMatch(/^Resolved by the team/);

    // As its owner now, they may undo a resolution made by mistake.
    expect(page.querySelector("details.reopen form")?.getAttribute("action")).toBe(
      "/tickets/SUP-1/reopen",
    );
  });
});

import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

const words = "My printer works again";
const tighter = "Ten pages print on the floor 2 printer with no jam";

async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer is broken", description: "It jams.", fix_check: words });
  return built;
}

describe("the agreed check", () => {
  it("is stored as none, with nothing written, when it only repeats the customer", async () => {
    const { app } = await setup();
    const res = await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: words });
    expect(res.body.agreed_check).toBeNull();
    expect((await admin(app).get("/api/tickets/SUP-1/events")).body).toHaveLength(1);
  });

  it("is set by a team member and kept beside the customer's own words", async () => {
    const { app } = await setup();
    const res = await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: tighter });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fix_check: words, agreed_check: tighter });
    // What is stored, not only what was returned.
    const stored = await admin(app).get("/api/tickets/SUP-1");
    expect(stored.body).toMatchObject({ fix_check: words, agreed_check: tighter });

    const history = await admin(app).get("/api/tickets/SUP-1/events");
    expect(history.body.at(-1)).toMatchObject({
      type: "check_agreed",
      data: { from: null, to: tighter },
    });
  });

  it("leaves the customer's words alone when the customer edits other text", async () => {
    const { app } = await setup();
    await as(app, teamActor).put("/api/tickets/SUP-1/agreed-check").send({ agreed_check: tighter });
    await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ title: "Printer still broken", description: "It jams.", fix_check: words });
    const ticket = await admin(app).get("/api/tickets/SUP-1");
    expect(ticket.body).toMatchObject({ fix_check: words, agreed_check: tighter });
  });

  it("is removed with an empty text, and writes nothing when unchanged", async () => {
    const { app } = await setup();
    const team = as(app, teamActor);
    await team.put("/api/tickets/SUP-1/agreed-check").send({ agreed_check: tighter });
    await team.put("/api/tickets/SUP-1/agreed-check").send({ agreed_check: ` ${tighter} ` });
    const removed = await team.put("/api/tickets/SUP-1/agreed-check").send({ agreed_check: "" });
    expect(removed.body.agreed_check).toBeNull();
    const types = (await admin(app).get("/api/tickets/SUP-1/events")).body.map(
      (e: { type: string }) => e.type,
    );
    expect(types).toEqual(["created", "check_agreed", "check_agreed"]);
  });

  it("cannot be set by the customer", async () => {
    const { app } = await setup();
    const res = await as(app, customerOne)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "Anything" });
    expect(res.status).toBe(403);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.agreed_check).toBeNull();
  });

  it("refuses text over 500 characters", async () => {
    const { app } = await setup();
    const res = await admin(app)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "a".repeat(501) });
    expect(res.status).toBe(400);
  });

  it("is shown to the customer beside their words, and the form to the team only", async () => {
    const { app } = await setup();
    const form = await as(app, teamActor)
      .post("/tickets/SUP-1/agreed-check")
      .type("form")
      .send({ agreed_check: `${tighter} <b>now</b>` });
    expect(form.status).toBe(303);

    const customer = await as(app, customerOne).get("/tickets/SUP-1");
    expect(customer.text).toContain("Team's check");
    expect(customer.text).toContain(`${tighter} &lt;b&gt;now&lt;/b&gt;`);
    // The customer's own words are the card's check; the team's is one quiet line under them.
    const card = parse(customer.text).querySelector(".ticket-card")!;
    expect(card.querySelector(".card-label")?.text).toBe("What would prove it is fixed?");
    expect(card.querySelector("blockquote")?.text).toBe(words);
    expect(card.querySelector("blockquote + .card-team-check")?.text).toContain("Team's check:");
    expect(customer.text).not.toContain("In your words");
    expect(customer.text).not.toContain('action="/tickets/SUP-1/agreed-check"');

    // The team's page has no form for it: the team's check stays in the API only.
    const team = await as(app, teamActor).get("/tickets/SUP-1");
    expect(team.text).not.toContain('action="/tickets/SUP-1/agreed-check"');
    expect(team.text).not.toContain("Offer a clearer check");
    // The history says it in words.
    expect(parse(team.text).querySelector("main")!.text).toContain("Team's check: ");
  });
});

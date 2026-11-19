import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The card at the top of a ticket says when the customer's latest word is that it is not fixed.
// Once the team resolved the ticket after that word and then reopened it, the old No is no
// longer the customer's latest word, so the card's line does not say it, to either of them.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

/** SUP-1 taken, started and handed to the customer to check. Returns the answer token. */
async function asked(app: Express): Promise<string> {
  const team = as(app, teamActor);
  await team.put("/api/tickets/SUP-1/change-link").send({ change_url: "https://example.com/c" });
  const ready = await team.post("/api/tickets/SUP-1/ready").send({});
  return ready.body.ready_token as string;
}

async function saidNo() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const token = await asked(app);
  await as(app, customerOne)
    .post("/api/tickets/SUP-1/answer")
    .send({ fixed: "no", comment: "Still happening", ready_token: token });
  return app;
}

/** The line on the ticket's card, or null when the card has none. */
const card = async (app: Express, who = teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text)
    .querySelector(".ticket-card .card-line > span")
    ?.text.trim() ?? null;

describe("the customer's No at the top of the ticket", () => {
  it("shows while it is their latest word", async () => {
    const app = await saidNo();
    expect(await card(app)).toMatch(/^The customer said it is not fixed on /);
  });

  it("is not shown after the team resolved and then reopened the ticket", async () => {
    const app = await saidNo();
    const resolved = await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "wont_fix" });
    expect(resolved.status).toBe(200);
    const reopened = await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "One more try at the fix." });
    expect(reopened.status).toBe(200);
    expect(await card(app)).toBeNull();
    expect(await card(app, customerOne)).toBeNull();
  });

  it("shows again when the customer says No again after that", async () => {
    const app = await saidNo();
    await as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "wont_fix" });
    await as(app, teamActor).post("/api/tickets/SUP-1/reopen").send({ reason: "One more try." });
    const token = await asked(app);
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "no", comment: "Partly fixed", ready_token: token });
    expect(await card(app, customerOne)).toMatch(/^You said it is not fixed on .+\.$/);
  });
});

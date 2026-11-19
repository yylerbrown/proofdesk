import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// When the customer says No, the ticket's owner must see it at once, with the customer's own
// words, and the ticket must be plainly back in the owner's hands.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};
const comment = "Still jams on page two when I print double-sided.";

/** Files a ticket as the customer and takes it as far as asking them. Returns the token. */
async function ask(app: Express): Promise<string> {
  const team = as(app, teamActor);
  await team.post("/api/tickets/SUP-1/take");
  await team.patch("/api/tickets/SUP-1").send({ status: "in_progress" });
  await team
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/change/1" });
  const ready = await team.post("/api/tickets/SUP-1/ready").send({
    try_url: "https://example.com/print",
    tried: "I printed ten pages.",
    result: "No jam.",
  });
  return ready.body.ready_token as string;
}

async function saidNo(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
  const token = await ask(app);
  const res = await as(app, customerOne)
    .post("/tickets/SUP-1/answer")
    .type("form")
    .send({ fixed: "no", comment, ready_token: token });
  expect(res.status).toBe(303);
}

describe("after the customer says No", () => {
  it("shows the owner the No and the customer's words first, and says it is back with them", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const box = html.querySelector("#customer-said-no");
    expect(box?.querySelector("h2")?.text).toBe("The customer says it is not fixed");
    expect(box?.querySelector("blockquote")?.text).toBe(comment);
    expect(box?.text).toContain("It is back with Team Member");
    // It is the first thing in the main part of the page.
    expect(html.querySelector(".ticket-summary")?.firstElementChild).toBe(box);
    const ticket = (await as(app, teamActor).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({
      status: "in_progress",
      waiting_on: "team",
      owner_name: "Team Member",
      customer_answer: { fixed: false, comment },
    });
  });

  it("says so in the team's list, and the customer reads it in their own words", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    const row = parse((await as(app, teamActor).get("/tickets")).text).querySelector("tbody tr");
    expect(row?.querySelector(".turn-tag")?.text).toBe("Customer said no");
    const mine = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#customer-said-no",
    );
    expect(mine?.querySelector("h2")?.text).toBe("You said it is not fixed");
    expect(mine?.text).toContain("You will be asked again");
  });

  it("goes away once the team asks again, and after a Yes", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    const token = (
      await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({
        try_url: "https://example.com/print",
        tried: "I printed ten pages, double-sided.",
        result: "No jam.",
        response: "Fixed double-sided printing too.",
      })
    ).body.ready_token;
    expect(
      parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
        "#customer-said-no",
      ),
    ).toBeNull();
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector("#customer-said-no")).toBeNull();
    expect(page.querySelector(".confirmed")).not.toBeNull();
  });

  it("is never shown to another customer, who cannot see the ticket at all", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    expect((await as(app, customerTwo).get("/tickets/SUP-1")).status).toBe(404);
  });
});

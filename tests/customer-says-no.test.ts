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
  it("tells the owner on the card, linked to the customer's words, with the ask again", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    const html = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const card = html.querySelector(".ticket-card")!;
    const line = card.querySelector(".card-line")!;
    expect(line.text.trim()).toMatch(/^The customer said no on \d{1,2} [A-Z][a-z]{2} \d{4}\.$/);
    // Their words stand once, in the conversation, and the line links to that message.
    expect(card.text).not.toContain(comment);
    const message = html.querySelector(line.querySelector("a")!.getAttribute("href")!)!;
    expect(message.classList.contains("entry")).toBe(true);
    expect(message.text).toContain(comment);
    // The card's step is to ask again, after the line. No red block of its own.
    expect(line.nextElementSibling?.querySelector("button")?.text).toBe(
      "Ask the customer to verify",
    );
    expect(html.querySelector("#customer-said-no")).toBeNull();
    const ticket = (await as(app, teamActor).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({
      status: "in_progress",
      waiting_on: "team",
      owner_name: "Team Member",
      customer_answer: { fixed: false, comment },
    });
  });

  it("says so in the team's list, and the customer reads it in their own terms", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    const row = parse((await as(app, teamActor).get("/tickets")).text).querySelector("tbody tr");
    expect(row?.querySelector(".turn-tag")?.text).toBe("Customer said no");
    const mine = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      ".ticket-card .card-line",
    );
    expect(mine?.text.trim()).toMatch(
      /^You said no on \d{1,2} [A-Z][a-z]{2} \d{4}\. The team will ask you again\.$/,
    );
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
    const line = async () =>
      parse((await as(app, teamActor).get("/tickets/SUP-1")).text)
        .querySelector(".ticket-card .card-line")
        ?.text.trim();
    expect(await line()).toMatch(/^Waiting for the customer's answer\./);
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: token });
    expect(await line()).toMatch(/^Customer confirmed on /);
  });

  it("is never shown to another customer, who cannot see the ticket at all", async () => {
    const { app } = buildTestApp();
    await saidNo(app);
    expect((await as(app, customerTwo).get("/tickets/SUP-1")).status).toBe(404);
  });
});

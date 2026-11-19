import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// An assistant's request for review is said once, on the ticket's card, as its line, with the
// ask outlined. The assistant's own card does not say it again, so a request with nothing else
// leaves no assistant card. While the customer's No stands, the card's line is the No, and then
// the ask is the thing to do, so it is not outlined.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

/** A ticket in progress, handed to an assistant, whose key is returned. */
async function handed(app: Express): Promise<string> {
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  const page = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
  const key = keyOnPage(page.text);
  await handToAgent(app, "SUP-1", key);
  return key;
}

async function askForReview(app: Express, key: string) {
  await request(app)
    .post("/api/tickets/SUP-1/owner-review")
    .set("Authorization", `Bearer ${key}`)
    .send({ message: "Evidence attached." })
    .expect(201);
}

const teamPage = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets/SUP-1")).text);

describe("a review request on the ticket page", () => {
  it("is the card's line with Mark fixed outlined, and leaves no assistant card on its own", async () => {
    const { app } = buildTestApp();
    await askForReview(app, await handed(app));
    const page = await teamPage(app);
    expect(page.querySelector(".ticket-card .card-line")?.text.trim()).toBe(
      "Helper asks for your review.",
    );
    const ask = page.querySelector(".ticket-card .next-action button")!;
    expect(ask.text).toBe("Mark fixed and tell the customer");
    expect(ask.classList.contains("secondary")).toBe(true);
    expect(page.querySelector(".assistant-card")).toBeNull();
  });

  it("does not outline Mark fixed while the customer's No is the card's line", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const ready = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "no", comment: "Page two still jams.", ready_token: ready.body.ready_token })
      .expect(200);
    const page = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
    const key = keyOnPage(page.text);
    await handToAgent(app, "SUP-1", key);
    await askForReview(app, key);
    const card = (await teamPage(app)).querySelector(".ticket-card")!;
    expect(card.querySelector(".card-line")?.text.trim()).toMatch(
      /^The customer says it is not fixed, since /,
    );
    const ask = card.querySelector(".next-action button")!;
    expect(ask.text).toBe("Mark fixed and tell the customer");
    expect(ask.classList.contains("secondary")).toBe(false);
  });
});

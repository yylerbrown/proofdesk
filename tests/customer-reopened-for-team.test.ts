import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { turnTag } from "../src/server/pages/format.js";
import type { Ticket } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, resolveTicket, teamActor, visitor } from "./helpers.js";

// When the customer reopens a ticket, the team sees it as plainly as after a No: the card's
// line says so and links to the customer's message, and the list's quiet tag says why it is back. A team member who reopens a ticket is told so in words written for them.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const reason = "It jams again on page three.";

/** The quiet tag after SUP-1's status in this person's list, or null when there is none. */
async function listTag(app: Express, who: Actor) {
  const row = parse((await as(app, who).get("/tickets")).text).querySelector("tbody tr");
  return row?.querySelector(".turn-tag")?.text ?? null;
}

/** Posts a ticket-page form as this person, then reads the message on the page it leads to. */
async function savedAfter(app: Express, who: Actor, path: string, fields: object) {
  const res = await as(app, who).post(path).type("form").send(fields);
  expect(res.status).toBe(303);
  const page = await visitor(app)
    .set("Cookie", [`${DEV_COOKIE}=${who.id}`, ...[res.headers["set-cookie"]].flat()])
    .get(res.headers.location!);
  return parse(page.text).querySelector("p.saved")?.text.trim();
}

describe("a ticket the customer reopened", () => {
  it("tells the team on the card, linked to their reason, and the list says it is not fixed", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    expect(await savedAfter(app, customerOne, "/tickets/SUP-1/reopen", { reason })).toBe(
      "Thank you. The ticket is back with the team.",
    );

    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    // The card says so in one line, linked to their words, which stand once, in the conversation.
    const line = page.querySelector(".ticket-card .card-line")!;
    expect(line.text.trim()).toMatch(
      /^The customer says it is not fixed, since \d{1,2} [A-Z][a-z]{2} \d{4}\.$/,
    );
    expect(page.querySelector(".ticket-card")!.text).not.toContain(reason);
    const href = line.querySelector("a")!.getAttribute("href")!;
    expect(page.querySelector(href)?.text).toContain(reason);
    expect(await listTag(app, teamActor)).toBe("Customer says not fixed");
    expect(await listTag(app, customerOne)).toBeNull();
    // The history keeps their reason too.
    const history = page.querySelectorAll("details.history tbody tr").map((row) => row.text);
    expect(history.some((row) => row.includes(`Reopened by the customer: ${reason}`))).toBe(true);
  });

  it("reads the same as a No, in one phrase", () => {
    const ticket = { waiting_on: "team", customer_answer: { fixed: false } } as Ticket;
    expect(turnTag(ticket, "team", { reopened: false, signal: undefined })).toBe(
      "Customer says not fixed",
    );
    expect(turnTag(ticket, "team", { reopened: true, signal: undefined })).toBe(
      "Customer says not fixed",
    );
    expect(turnTag(ticket, "customer", { reopened: true, signal: undefined })).toBeNull();
  });

  it("reads as asked once the team asks the customer again", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    await as(app, customerOne).post("/api/tickets/SUP-1/reopen").send({ reason }).expect(200);
    // resolveTicket left the admin as its owner, who asks again.
    await visitor(app)
      .set("Cookie", `${DEV_COOKIE}=dev-admin-1`)
      .post("/api/tickets/SUP-1/ready")
      .send({})
      .expect(200);
    expect(await listTag(app, teamActor)).toBe("Asked the customer");
  });
});

describe("a team member reopening a ticket", () => {
  it("is told in words written for them, not for the customer", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "wont_fix" })
      .expect(200);
    const said = await savedAfter(app, teamActor, "/tickets/SUP-1/reopen", {
      reason: "Resolved by mistake.",
    });
    expect(said).toBe("Reopened, with your reason.");
  });
});

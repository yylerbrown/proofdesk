import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { waitingOn } from "../src/server/pages/format.js";
import type { Ticket } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, resolveTicket, teamActor, visitor } from "./helpers.js";

// When the customer reopens a ticket, the team sees it as plainly as after a No: a callout
// with their reason at the top of the ticket, and the list's Waiting on column says why it is
// back. A team member who reopens a ticket is told so in words written for them.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const reason = "It jams again on page three.";

/** The Waiting on cell of SUP-1 in this person's list. */
async function waitingCell(app: Express, who: Actor) {
  const row = parse((await as(app, who).get("/tickets")).text).querySelector("tbody tr");
  return row?.querySelectorAll("td")[4]?.text.trim();
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
  it("shows the team a callout with their reason, and the list says the customer reopened it", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    expect(await savedAfter(app, customerOne, "/tickets/SUP-1/reopen", { reason })).toBe(
      "Reopened. The team has your words.",
    );

    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const box = page.querySelector("#customer-said-no")!;
    expect(box.querySelector("h2")?.text).toBe("The customer reopened it");
    expect(box.querySelector("blockquote")?.text).toBe(reason);
    expect(await waitingCell(app, teamActor)).toBe("Support team: customer reopened it");
    expect(await waitingCell(app, customerOne)).toBe("Support team");
    // The history keeps their reason too.
    const history = page.querySelectorAll("details.history tbody tr").map((row) => row.text);
    expect(history.some((row) => row.includes(`Reopened by the customer: ${reason}`))).toBe(true);
  });

  it("is told apart from an older No, which the reopening replaces", () => {
    const ticket = { waiting_on: "team", customer_answer: { fixed: false } } as Ticket;
    expect(waitingOn(ticket, "team")).toBe("Support team: customer says it still fails");
    expect(waitingOn(ticket, "team", true)).toBe("Support team: customer reopened it");
    expect(waitingOn(ticket, "customer", true)).toBe("Support team");
  });

  it("goes back to the plain word once the team asks the customer again", async () => {
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
    expect(await waitingCell(app, teamActor)).toBe("Customer");
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

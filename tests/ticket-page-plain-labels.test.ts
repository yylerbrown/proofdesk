import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// Small words on the ticket page that a first look must read right: each button and line says
// what it does, an example is never the ticket's own key, and nothing is said twice.

/** The demo's ticket page as one of its made-up people. */
async function demoPage(id: string, key: string) {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const res = await visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).get(`/tickets/${key}`);
  expect(res.status).toBe(200);
  return parse(res.text);
}

/** A fresh app with one ticket the team owns and is working on. */
async function workedTicket() {
  const { app } = buildTestApp();
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams on page two." });
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return app;
}

describe("the ticket page's labels", () => {
  it("gives the Duplicate of box an example key that is not this ticket's", async () => {
    const app = await workedTicket();
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text);
    const box = page.querySelector('#resolve-form input[name="duplicate_of"]')!;
    expect(box.getAttribute("placeholder")).toBe("A ticket key, like SUP-12");
    expect(box.getAttribute("value")).toBe("");
  });

  it("names the customer's audience on their send button, and keeps the team's two labels", async () => {
    const app = await workedTicket();
    const customer = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(customer.querySelector(".reply-actions button")?.text).toBe("Send to the team");
    const team = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const send = team.querySelector(".reply-actions button")!;
    expect(send.getAttribute("data-label-reply")).toBe("Send reply to customer");
    expect(send.getAttribute("data-label-note")).toBe("Save internal note");
  });

  it("says once, without the repeat, that the team resolved it with a reason", async () => {
    const app = await workedTicket();
    const team = as(app, teamActor);
    const res = await team
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "Not ours to fix.", expected_version: "3" });
    expect(res.status).toBe(303);
    const page = parse((await team.get(res.headers.location!)).text);
    expect(page.querySelector("p.saved")?.text).toBe("Resolved, with your reason.");
    expect(page.querySelector(".ticket-card .card-line")?.text).toContain(
      "The customer can reopen it.",
    );
  });
});

describe("the assistant's card", () => {
  it("shows what the assistant reported above Accept test and Discard, as sent", async () => {
    const page = await demoPage("demo-team", "SUP-2");
    const card = page.querySelector(".assistant-card")!;
    const reported = card.querySelector(".card-reported")!;
    expect(reported.text.trim()).toBe(
      "Reported by the assistant, not checked by Proofdesk: 3 passed, 0 failed (Node v25.2.1)",
    );
    // It comes before the decision's two buttons.
    expect(reported.nextElementSibling?.classList.contains("card-decision")).toBe(true);
  });

  it("prints the day the run was recorded as written, not as a time to move", async () => {
    const page = await demoPage("demo-team", "SUP-2");
    const recorded = page.querySelector(".assistant-card .card-recorded")!;
    expect(recorded.querySelector("time")).toBeNull();
    expect(recorded.text).toContain("Recorded on 18 Nov 2026 on an earlier copy of this demo");
  });

  it("is the review request for every viewer, so the read-only admin is not told twice", async () => {
    for (const id of ["demo-team", "demo-admin"]) {
      const page = await demoPage(id, "SUP-2");
      expect(page.querySelector(".assistant-card .card-proposal")).not.toBeNull();
      expect(page.text, id).not.toContain("asks for your review.");
    }
  });
});

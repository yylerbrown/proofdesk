import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, refusedBackToTicket, teamActor } from "./helpers.js";

// Pressing "Withdraw the question" on the ticket page, as a browser with no script sends it.
// The JSON API's version of this step has its own tests; these run the page's form.

const ask = {
  try_url: "https://example.com/print",
  tried: "Printed ten pages.",
  result: "No jam.",
};

/** Files a ticket, and the team member takes it, starts it and asks the customer. */
async function asked(app: Express) {
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "On page two.", fix_check: "Ten pages print" });
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await as(app, teamActor)
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/c" });
  const res = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask);
  expect(res.status).toBe(200);
  return res.body as { version: number };
}

/** The version field the page's own withdraw form carries. */
async function formVersion(app: Express): Promise<string> {
  const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
  const field = page.querySelector(
    "form[action$='/withdraw-question'] input[name='expected_version']",
  );
  expect(field).not.toBeNull();
  return field!.getAttribute("value")!;
}

describe("withdrawing the question from the ticket page", () => {
  it("takes the owner back to the ticket, says so and ends the open question", async () => {
    const { app } = buildTestApp();
    await asked(app);
    const browser = as(app, teamActor);
    const res = await browser
      .post("/tickets/SUP-1/withdraw-question")
      .type("form")
      .send({ expected_version: await formVersion(app) });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1");

    const page = parse((await browser.get("/tickets/SUP-1")).text);
    expect(page.querySelector('p[role="status"].saved')?.text).toContain("Question withdrawn");
    // The form is gone, because no question is open now.
    expect(page.querySelector("form[action$='/withdraw-question']")).toBeNull();
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.ready_at).toBeNull();
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.filter((event) => event.type === "question_withdrawn")).toHaveLength(1);
  });

  it("refuses anyone but the owner, back on the ticket with the reason", async () => {
    const { app } = buildTestApp();
    await asked(app);
    const reason = await refusedBackToTicket(admin(app), "/tickets/SUP-1/withdraw-question");
    expect(reason).toContain("Only the owner");
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.ready_at).not.toBeNull();
  });

  it("refuses a form from a page opened before the ticket changed", async () => {
    const { app, db } = buildTestApp();
    await asked(app);
    const old = await formVersion(app);
    // Any change to the ticket's row raises its version; this one is made directly.
    db.prepare("UPDATE tickets SET title = ? WHERE id = 1").run("Printer jams on page two");
    const reason = await refusedBackToTicket(
      as(app, teamActor),
      "/tickets/SUP-1/withdraw-question",
      { expected_version: old },
    );
    expect(reason).toContain("changed");
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket.ready_at).not.toBeNull();
  });

  it("pressed twice changes the ticket once", async () => {
    const { app } = buildTestApp();
    await asked(app);
    const version = await formVersion(app);
    const browser = as(app, teamActor);
    for (let n = 0; n < 2; n += 1) {
      const res = await browser
        .post("/tickets/SUP-1/withdraw-question")
        .type("form")
        .send({ expected_version: version });
      expect(res.status).toBe(303);
      expect(res.headers.location).toBe("/tickets/SUP-1");
    }
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.filter((event) => event.type === "question_withdrawn")).toHaveLength(1);
  });
});

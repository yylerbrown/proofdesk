import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { confirmedAt } from "../src/server/pages/format.js";
import type { Ticket, TicketEvent } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, resolveTicket } from "./helpers.js";

// The tick means "the customer confirmed it". Inside the product (the page under the header,
// where the mark sits beside the name) it appears in exactly one place: on a ticket the
// customer resolved by answering yes.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

/** The page under the header, as the customer sees it. */
async function ticketMain(app: Express, address = "/tickets/SUP-1") {
  const res = await as(app, customerOne).get(address);
  expect(res.status).toBe(200);
  return parse(res.text).querySelector("main")!;
}

const ticks = (main: ReturnType<typeof parse>) =>
  main.querySelectorAll("img[src='/assets/mark.svg']");

/** Files a ticket and takes it as far as asking the customer, without an answer. */
async function markReady(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
  await admin(app).post("/api/tickets/SUP-1/take");
  await admin(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
  await admin(app)
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/c" });
  return admin(app)
    .post("/api/tickets/SUP-1/ready")
    .send({ try_url: "https://example.com/try", tried: "I printed ten pages.", result: "No jam." });
}

describe("the tick", () => {
  it("is not shown when a fix is linked and the ticket is marked ready but not answered", async () => {
    const { app } = buildTestApp();
    expect((await markReady(app)).status).toBe(200);
    for (const who of [as(app, customerOne), admin(app)]) {
      const main = parse((await who.get("/tickets/SUP-1")).text).querySelector("main")!;
      expect(ticks(main)).toHaveLength(0);
      expect(main.querySelector(".confirmed")).toBeNull();
      // Nothing says it is resolved. The one line saying how it becomes Resolved is the
      // exception, so it is left out of the check.
      main.querySelector(".status-rule")?.remove();
      expect(main.text).not.toMatch(/resolved/i);
    }
  });

  it("is shown once on a ticket the customer confirmed, and nowhere in the list", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    const main = await ticketMain(app);
    expect(ticks(main)).toHaveLength(1);
    expect(main.querySelector(".confirmed")?.text).toContain("Customer confirmed it is fixed.");
    expect(main.querySelector(".confirmed time")?.getAttribute("datetime")).toMatch(/Z$/);
    expect(ticks(await ticketMain(app, "/tickets"))).toHaveLength(0);
  });

  it("is not shown when the customer answers no", async () => {
    const { app } = buildTestApp();
    const ready = await markReady(app);
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "no", comment: "Still jams.", ready_token: ready.body.ready_token });
    expect(ticks(await ticketMain(app))).toHaveLength(0);
  });

  it("goes away if a confirmed ticket is opened again", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await resolveTicket(app, "SUP-1", customerOne);
    // Only the customer reopens, by saying it is still happening.
    const reopened = await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It jams again." });
    expect(reopened.status).toBe(200);
    expect(ticks(await ticketMain(app))).toHaveLength(0);
  });
});

describe("confirmedAt", () => {
  const resolved = { status: "resolved" } as unknown as Ticket;
  const answer = (fixed: boolean, at: string): TicketEvent => ({
    id: 1,
    ticket_key: "SUP-1",
    actor: "dev-customer-1",
    actor_kind: "person",
    type: "customer_answered",
    data: { fixed },
    created_at: at,
    context: null,
  });

  it("counts only the latest answer, and only a yes", () => {
    const yes = answer(true, "2026-11-17T10:00:00.000Z");
    const no = answer(false, "2026-11-17T11:00:00.000Z");
    expect(confirmedAt(resolved, [no, yes])).toBe("2026-11-17T10:00:00.000Z");
    expect(confirmedAt(resolved, [yes, no])).toBeNull();
    expect(confirmedAt(resolved, [])).toBeNull();
  });
});

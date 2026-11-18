import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, refusedBackToTicket, teamActor } from "./helpers.js";

// A tab opened before the ticket was resolved still shows "Ask the customer to verify". Pressing
// it then sends nothing, and the refusal is worded from the ticket as it is now: resolved, not
// waiting to be moved to In Progress.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

describe("asking the customer from a stale tab", () => {
  it("on a ticket resolved since, says it was resolved and how to ask again", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "cannot_reproduce" })
      .expect(200);
    const reason = await refusedBackToTicket(as(app, teamActor), "/tickets/SUP-1/ready");
    expect(reason).toBe(
      "Ticket SUP-1 was resolved, so nothing was sent. Reopen it first if it needs another check.",
    );
  });

  it("on a New ticket, keeps asking for In Progress first", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take").expect(200);
    const res = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    expect(res.body.error.message).toBe("Move ticket SUP-1 to In Progress first.");
  });
});

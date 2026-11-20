import { describe, expect, it } from "vitest";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, customerOne, teamActor } from "./helpers.js";

// A customer's No adds their words to the conversation, so it counts against the same budget of
// entries per ticket as an ordinary reply and a reopen. Past the budget it is refused and the
// ticket is left as it was.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

describe("a customer's No and the entries budget", () => {
  it("is refused when the ticket holds no more entries, and changes nothing", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP", { entriesPerTicket: 2 });
    service.createTicket(valid, customerOne);
    service.takeAndStart("SUP-1", teamActor, {});
    service.linkChange("SUP-1", { change_url: "https://example.com/change/1" }, teamActor);
    const asked = service.markReady(
      "SUP-1",
      { try_url: "https://example.com/print", tried: "I printed ten pages.", result: "No jam." },
      teamActor,
    );
    service.addEntry("SUP-1", { kind: "reply", body: "One" }, teamActor);
    service.addEntry("SUP-1", { kind: "reply", body: "Two" }, teamActor);
    const entries = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM ticket_entries").get() as { n: number }).n;
    expect(entries()).toBe(2);
    const before = service.getTicket("SUP-1", teamActor);

    expect(() =>
      service.answer(
        "SUP-1",
        { fixed: "no", comment: "Still jams.", ready_token: asked.ready_token },
        customerOne,
      ),
    ).toThrow(/holds no more replies/);
    expect(entries()).toBe(2);
    // Still waiting for the customer's answer, as before.
    expect(service.getTicket("SUP-1", teamActor)).toEqual(before);
  });
});

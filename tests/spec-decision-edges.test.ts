import { describe, expect, it } from "vitest";
import { HttpError } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne } from "./helpers.js";

// Deciding on a ticket's test spec when there is nothing to decide, or nothing left to change.

const spec = {
  summary: "Printing ten pages in a row works from a full tray.",
  scenarios: [
    {
      title: "Ten pages from the tray",
      given: "a full paper tray",
      when: "ten pages are printed in one job",
      then: "all ten come out and none jams",
    },
  ],
};

function setUp() {
  const { db, config } = buildTestApp();
  const tickets = createTicketService(db, config.ticketPrefix);
  const { key } = tickets.createTicket(
    { title: "Printer jams", description: "It jams on page two.", fix_check: "Ten pages print" },
    customerOne,
  );
  return { tickets, key };
}

/** The error a call throws, so its status and code can be checked. */
function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("The call was not refused.");
}

describe("deciding on a test spec", () => {
  it.each(["accept", "discard"])(
    "is refused with no_spec when the ticket has no spec, to %s it",
    (decision) => {
      const { tickets, key } = setUp();
      const error = refusal(() => tickets.decideSpec(key, { decision }, adminActor));
      expect(error.status).toBe(409);
      expect(error.code).toBe("no_spec");
    },
  );

  it("returns an accepted spec unchanged when it is accepted again, adding no history", () => {
    const { tickets, key } = setUp();
    tickets.proposeSpec(key, spec, adminActor);
    const first = tickets.decideSpec(key, { decision: "accept" }, adminActor);
    const accepted = () =>
      tickets.listEvents(key, adminActor).filter((event) => event.type === "spec_accepted");
    expect(accepted()).toHaveLength(1);

    const again = tickets.decideSpec(key, { decision: "accept" }, adminActor);
    expect(again).toEqual(first);
    expect(again.state).toBe("accepted");
    expect(accepted()).toHaveLength(1);
  });
});

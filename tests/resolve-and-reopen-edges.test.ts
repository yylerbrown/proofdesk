import { describe, expect, it } from "vitest";
import { HttpError, ValidationError } from "../src/server/errors.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Resolving with a reason and reopening, called straight on the service: a duplicate that names
// no ticket key at all, and a customer reopening a ticket that has no room left for their reply.

function setUp(entriesPerTicket?: number) {
  const { db, config } = buildTestApp();
  const budget = entriesPerTicket === undefined ? {} : { entriesPerTicket };
  const service = createTicketService(db, config.ticketPrefix, budget);
  const filed = service.createTicket(
    { title: "Printer jams", description: "On page two.", fix_check: "Ten pages print" },
    customerOne,
  );
  return { db, service, key: filed.key };
}

/** Runs the step and returns the refusal it throws. */
function refusal(step: () => unknown): HttpError {
  try {
    step();
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error("The step was not refused");
}

describe("resolving as a duplicate", () => {
  it.each(["hello", "SUP", "SUP-x", "123"])(
    "refuses %s, which is not a ticket key, as a field error",
    (typed) => {
      const { service, key } = setUp();
      const err = refusal(() =>
        service.resolveWithReason(key, { reason: "duplicate", duplicate_of: typed }, teamActor),
      );
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
      expect((err as ValidationError).fieldErrors.duplicate_of?.[0]).toContain(
        "Name another ticket that exists",
      );
      // Nothing was saved.
      expect(service.getTicket(key, teamActor).status).toBe("new");
    },
  );

  it("accepts a real key typed in lower case", () => {
    const { service, key } = setUp();
    service.createTicket({ title: "Second", description: "x", fix_check: "It works" }, customerOne);
    const resolved = service.resolveWithReason(
      key,
      { reason: "duplicate", duplicate_of: "sup-2" },
      teamActor,
    );
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution?.duplicate_of).toBe("SUP-2");
  });
});

describe("a customer reopening a ticket", () => {
  /** Resolves the ticket with a reason, as the team does, after the given replies. */
  function resolvedWithReplies(entriesPerTicket: number, replies: number) {
    const set = setUp(entriesPerTicket);
    for (let n = 1; n <= replies; n += 1) {
      set.service.addEntry(set.key, { kind: "reply", body: `Reply ${n}` }, customerOne);
    }
    set.service.resolveWithReason(set.key, { reason: "fixed_no_reply" }, adminActor);
    return set;
  }

  it("is refused when the ticket holds no more replies", () => {
    const { service, key } = resolvedWithReplies(2, 2);
    const err = refusal(() => service.reopen(key, { reason: "Still jams." }, customerOne));
    expect(err.status).toBe(409);
    expect(err.code).toBe("budget_full");
    expect(err.message).toContain("replies on this ticket");
    expect(service.getTicket(key, customerOne).status).toBe("resolved");
  });

  it("goes through while there is room for one more reply", () => {
    const { service, key } = resolvedWithReplies(2, 1);
    const reopened = service.reopen(key, { reason: "Still jams." }, customerOne);
    expect(reopened.status).toBe("in_progress");
    expect(service.listEntries(key, customerOne).map((entry) => entry.body)).toContain(
      "Still jams.",
    );
  });

  it("is not counted against replies when the admin reopens it", () => {
    const { service, key } = resolvedWithReplies(2, 2);
    const reopened = service.reopen(key, { reason: "Resolved by mistake." }, adminActor);
    expect(reopened.status).toBe("in_progress");
  });
});

import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { HttpError } from "../src/server/errors.js";
import { createTicketService, type TicketService } from "../src/server/tickets/service.js";
import { adminActor, as, buildTestApp, customerOne } from "./helpers.js";

// Who is asking is checked before what they sent. A caller who may not take an action is
// refused with 403 even when the input is also wrong, so they learn nothing about the input
// rules, and a stale form from a role that can no longer act gets the plain refusal.

// The read-only admin, as in the demo's admin preview: it may read every ticket and change none.
const readOnlyAdmin: Actor = { ...adminActor, readOnly: true };

// Input no action accepts: every required field is missing.
const empty = {};

type Run = (service: TicketService, actor: Actor) => unknown;

// Every action on one ticket that takes input, with the person who is allowed to take it.
const actions: [string, Actor, Run][] = [
  ["change status", adminActor, (s, a) => s.changeStatus("SUP-1", empty, a)],
  ["edit", adminActor, (s, a) => s.editTicket("SUP-1", empty, a)],
  ["agree on the check", adminActor, (s, a) => s.agreeCheck("SUP-1", empty, a)],
  ["link the change", adminActor, (s, a) => s.linkChange("SUP-1", { change_url: "x" }, a)],
  ["ask the customer", adminActor, (s, a) => s.markReady("SUP-1", { try_url: "x" }, a)],
  ["answer", customerOne, (s, a) => s.answer("SUP-1", empty, a)],
  ["reopen", customerOne, (s, a) => s.reopen("SUP-1", empty, a)],
  ["resolve with a reason", adminActor, (s, a) => s.resolveWithReason("SUP-1", empty, a)],
  ["hand off", adminActor, (s, a) => s.handOff("SUP-1", empty, a)],
  ["hand to an agent", adminActor, (s, a) => s.giveToAgent("SUP-1", empty, a)],
  ["add evidence", adminActor, (s, a) => s.addEvidence("SUP-1", empty, a)],
  ["add a reply or note", adminActor, (s, a) => s.addEntry("SUP-1", empty, a)],
  ["add a note", adminActor, (s, a) => s.addNote("SUP-1", empty, a)],
  ["ask the owner to review", adminActor, (s, a) => s.askOwnerToReview("SUP-1", empty, a)],
  ["delete", adminActor, (s, a) => s.deleteTicket("SUP-1", 42, a)],
  ["propose a spec", adminActor, (s, a) => s.proposeSpec("SUP-1", empty, a)],
  ["decide on the spec", adminActor, (s, a) => s.decideSpec("SUP-1", empty, a)],
];

/** A service with SUP-1, filed by customer one. */
function oneTicket(): TicketService {
  const { db } = buildTestApp();
  const service = createTicketService(db, "SUP");
  service.createTicket({ title: "Printer is broken", description: "It jams." }, customerOne);
  return service;
}

/** The status and code a call is refused with. */
function refusal(call: () => unknown): { status: number; code: string } {
  try {
    call();
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  throw new Error("The call was not refused.");
}

describe("bad input from someone who may not act", () => {
  it.each(actions)("%s: is refused as not allowed, not as bad input", (_name, _allowed, run) => {
    const service = oneTicket();
    expect(refusal(() => run(service, readOnlyAdmin))).toEqual({
      status: 403,
      code: "forbidden",
    });
  });

  it.each(actions)("%s: the same input is still bad input for someone allowed", (_n, who, run) => {
    const service = oneTicket();
    expect(refusal(() => run(service, who))).toEqual({ status: 400, code: "validation_error" });
  });

  it("the JSON API answers 403 to a customer's bad status change", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer is broken", description: "It jams." });
    const res = await as(app, customerOne).patch("/api/tickets/SUP-1").send({ status: "nope" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });
});

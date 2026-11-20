import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne, teamActor } from "./helpers.js";

// One owner change for many tickets, called straight on the service. These are the sides of
// the change the list's tests do not reach: nobody for a ticket nobody owns, a person who owns
// it already with no stored name, choosing yourself by your own id, and handing an unowned
// ticket to someone else.

const secondMember: Actor = { id: "team-two", kind: "person", role: "team", name: "Second Member" };

function setUp(count = 1) {
  const { db, config } = buildTestApp();
  const team = [
    { id: adminActor.id, name: adminActor.name },
    { id: teamActor.id, name: teamActor.name },
    { id: secondMember.id, name: secondMember.name },
  ];
  const service = createTicketService(db, config.ticketPrefix, {}, { teamMembers: () => team });
  const keys: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const filed = service.createTicket(
      { title: `Ticket ${n}`, description: "x", fix_check: "It works" },
      customerOne,
    );
    keys.push(filed.key);
  }
  return { db, service, keys };
}

describe("giving many tickets to nobody", () => {
  it("leaves a ticket nobody owns as it is, and says nobody owns it already", () => {
    const { service, keys } = setUp(2);
    service.takeTicket(keys[1]!, teamActor);
    const outcome = service.changeTickets({ keys, owner: "nobody" }, teamActor);
    expect(outcome.changed).toEqual([keys[1]]);
    expect(outcome.not_changed).toHaveLength(1);
    expect(outcome.not_changed[0]!.key).toBe(keys[0]);
    expect(outcome.not_changed[0]!.code).toBe("nothing_to_change");
    expect(outcome.not_changed[0]!.message).toBe(`Nobody owns ${keys[0]} already.`);
  });
});

describe("giving many tickets to one person", () => {
  it("says that person owns it already when their name was never stored", () => {
    const { db, service, keys } = setUp();
    db.prepare("UPDATE tickets SET owner_id = ?, owner_name = NULL WHERE id = 1").run(
      secondMember.id,
    );
    const outcome = service.changeTickets({ keys, owner: secondMember.id }, adminActor);
    expect(outcome.changed).toEqual([]);
    expect(outcome.not_changed[0]!.code).toBe("nothing_to_change");
    expect(outcome.not_changed[0]!.message).toBe(`That person owns ${keys[0]} already.`);
  });

  it("names the owner when their name is stored", () => {
    const { service, keys } = setUp();
    service.takeTicket(keys[0]!, teamActor);
    const outcome = service.changeTickets({ keys, owner: teamActor.id }, adminActor);
    expect(outcome.not_changed[0]!.message).toBe(`${teamActor.name} owns ${keys[0]} already.`);
  });

  it("hands a ticket nobody owns straight to the person chosen", () => {
    const { service, keys } = setUp();
    const outcome = service.changeTickets({ keys, owner: secondMember.id }, adminActor);
    expect(outcome.changed).toEqual(keys);
    expect(service.getTicket(keys[0]!, adminActor).owner_id).toBe(secondMember.id);
  });
});

describe("choosing yourself by your own id", () => {
  it("is the same change as choosing me", () => {
    const { service, keys } = setUp(2);
    service.takeTicket(keys[1]!, teamActor);
    const outcome = service.changeTickets({ keys, owner: teamActor.id }, teamActor);
    expect(outcome.change).toEqual({ owner: "me" });
    expect(outcome.changed).toEqual([keys[0]]);
    // A ticket that is already theirs is described as theirs, not by their name.
    expect(outcome.not_changed[0]!.message).toBe(`${keys[1]} is yours already.`);
    expect(service.getTicket(keys[0]!, teamActor).owner_id).toBe(teamActor.id);
  });

  it("passes the same check without touching any ticket", () => {
    const { service, keys } = setUp();
    expect(() => service.checkChange({ keys, owner: teamActor.id }, teamActor)).not.toThrow();
    expect(service.getTicket(keys[0]!, teamActor).owner_id).toBeNull();
  });
});

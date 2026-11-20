import { describe, expect, it } from "vitest";
import { createConnectionService } from "../src/server/connections/service.js";
import { createTicketService } from "../src/server/tickets/service.js";
import type { Ticket } from "../src/server/tickets/types.js";
import { adminActor, buildTestApp, customerOne } from "./helpers.js";

// Handing a ticket to the assistant that already has it, and ending work when there is none,
// change nothing: no new version and no new history entry.

function setUp() {
  const { db, config } = buildTestApp();
  const tickets = createTicketService(db, config.ticketPrefix);
  const connections = createConnectionService(db, () => true);
  const issued = connections.create({ name: "Helper", scopes: ["read_tickets"] }, adminActor);
  const connectionId = connections.authenticate(issued.key)!.connection!.id;
  const { key } = tickets.createTicket(
    { title: "Printer jams", description: "It jams on page two.", fix_check: "Ten pages print" },
    customerOne,
  );
  tickets.takeAndStart(key, adminActor);
  return { tickets, key, connectionId };
}

const handedEvents = (tickets: ReturnType<typeof setUp>["tickets"], key: string) =>
  tickets.listEvents(key, adminActor).filter((event) => event.type === "agent_handed");

describe("giving a ticket to an assistant", () => {
  it("returns the ticket unchanged when that assistant already has it", () => {
    const { tickets, key, connectionId } = setUp();
    const first = tickets.giveToAgent(key, { connection_id: connectionId }, adminActor);
    expect(first.agent_id).toBe(String(connectionId));
    expect(handedEvents(tickets, key)).toHaveLength(1);

    const again = tickets.giveToAgent(key, { connection_id: connectionId }, adminActor);
    expect(again.version).toBe(first.version);
    expect(again.agent_id).toBe(String(connectionId));
    expect(handedEvents(tickets, key)).toHaveLength(1);
  });
});

describe("ending an assistant's work", () => {
  it.each([
    ["no input", undefined],
    ["an empty input", null],
  ])("ends it when called with %s", (_name, input) => {
    const { tickets, key, connectionId } = setUp();
    tickets.giveToAgent(key, { connection_id: connectionId }, adminActor);
    const ended =
      input === undefined
        ? tickets.endAgentWork(key, adminActor)
        : tickets.endAgentWork(key, adminActor, input);
    expect(ended.agent_id).toBeNull();
  });

  it("changes nothing when no assistant has the ticket", () => {
    const { tickets, key } = setUp();
    const before = tickets.getTicket(key, adminActor);
    const after = tickets.endAgentWork(key, adminActor);
    expect(after.version).toBe(before.version);
    expect(after.agent_id).toBeNull();
  });
});

describe("what an assistant last said it needs", () => {
  it("skips a ticket whose key is not one of this desk's", () => {
    const { tickets, key } = setUp();
    const ticket = tickets.getTicket(key, adminActor);
    const stranger: Ticket = { ...ticket, key: "OTHER-1" };
    expect(tickets.assistantSignals([stranger], adminActor).size).toBe(0);
  });
});

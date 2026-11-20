import { describe, expect, it } from "vitest";
import { createConnectionService, DEFAULT_SCOPES } from "../src/server/connections/service.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne } from "./helpers.js";

// The flag that makes a note a suggested reply counts only on an assistant's note, whichever
// door the note comes through. Here it comes through addEntry, the door for replies and notes.

function setUp() {
  const { db, config } = buildTestApp();
  const tickets = createTicketService(db, config.ticketPrefix);
  const connections = createConnectionService(db, () => true);
  const agent = connections.authenticate(
    connections.create({ name: "Helper", scopes: DEFAULT_SCOPES }, adminActor).key,
  )!;
  const { key } = tickets.createTicket(
    { title: "Printer jams", description: "It jams on page two.", fix_check: "Ten pages print" },
    customerOne,
  );
  tickets.takeAndStart(key, adminActor);
  tickets.giveToAgent(key, { connection_id: agent.connection!.id }, adminActor);
  return { tickets, key, agent };
}

describe("a note marked as a suggested reply, sent through addEntry", () => {
  it("is a suggested reply when an assistant writes it", () => {
    const { tickets, key, agent } = setUp();
    const entry = tickets.addEntry(
      key,
      { kind: "note", body: "Try reseating the tray.", suggested_reply: true },
      agent,
    );
    expect(entry.purpose).toBe("suggested_reply");
  });

  it("is an ordinary note when the assistant leaves the flag off", () => {
    const { tickets, key, agent } = setUp();
    const entry = tickets.addEntry(key, { kind: "note", body: "Looked at the tray." }, agent);
    expect(entry.purpose).toBe("note");
  });

  it("is an ordinary note when a person sets the flag", () => {
    const { tickets, key } = setUp();
    const entry = tickets.addEntry(
      key,
      { kind: "note", body: "Try reseating the tray.", suggested_reply: true },
      adminActor,
    );
    expect(entry.purpose).toBe("note");
  });
});

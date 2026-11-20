import { afterEach, describe, expect, it, vi } from "vitest";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, customerOne, teamActor } from "./helpers.js";

// Sending a ticket back to New answers with the ticket as it is stored, so a client that keeps
// the answer's updated_at holds the same time the next read gives.

afterEach(() => {
  vi.restoreAllMocks();
});

describe("returning a ticket to New", () => {
  it("answers with the updated_at that was stored", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket({ title: "Printer jams", description: "It jams." }, customerOne);
    service.takeAndStart("SUP-1", teamActor, {});
    // Each clock reading is a second after the one before, so two writes in one change never
    // share a time by chance.
    const real = Date.prototype.toISOString;
    let tick = 0;
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
      tick += 1;
      return real.call(new Date(this.getTime() + tick * 1000));
    });
    const answered = service.changeStatus("SUP-1", { status: "new" }, teamActor);
    vi.restoreAllMocks();
    const stored = service.getTicket("SUP-1", teamActor);
    expect(answered.status).toBe("new");
    expect(answered.updated_at).toBe(stored.updated_at);
    expect(answered.version).toBe(stored.version);
  });
});

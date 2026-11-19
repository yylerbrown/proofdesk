import { describe, expect, it } from "vitest";
import { describeActor, describeEvent, formatTime } from "../src/server/pages/format.js";
import type { TicketEvent } from "../src/server/tickets/service.js";

function event(type: string, data: unknown): TicketEvent {
  return {
    id: 1,
    ticket_key: "SUP-1",
    actor: "anonymous",
    actor_kind: "person",
    type,
    data,
    created_at: "2026-11-17T19:56:00.000Z",
    context: null,
  };
}

describe("formatTime", () => {
  it("shows the day, month, year and time in UTC", () => {
    const text = formatTime("2026-11-17T19:56:00.000Z");
    expect(text).toContain("17 Nov 2026");
    expect(text).toContain("19:56");
    expect(text.endsWith(" UTC")).toBe(true);
  });
});

describe("describeEvent", () => {
  it("describes a new ticket", () => {
    expect(describeEvent(event("created", { status: "new" }))).toBe("Ticket filed");
  });

  it("describes a status change with the labels people see", () => {
    expect(describeEvent(event("status_changed", { from: "in_progress", to: "resolved" }))).toBe(
      "Status changed from In Progress to Resolved",
    );
  });

  it("falls back to the type for an entry it does not know", () => {
    expect(describeEvent(event("something_new", {}))).toBe("something_new");
    expect(describeEvent(event("status_changed", { from: "odd" }))).toBe("status_changed");
  });
});

describe("describeActor", () => {
  const names = new Map([["u-1", "Sam Rivera"]]);

  it("shows a person by display name, not by id", () => {
    expect(describeActor({ ...event("created", {}), actor: "u-1" }, names)).toBe("Sam Rivera");
  });

  it("marks an AI assistant as one", () => {
    const agent = { ...event("created", {}), actor: "u-1", actor_kind: "agent" as const };
    expect(describeActor(agent, names)).toBe("Sam Rivera (AI assistant)");
  });

  it("does not show an id that has no name", () => {
    expect(describeActor(event("created", {}), names)).toBe("Unknown person");
  });
});

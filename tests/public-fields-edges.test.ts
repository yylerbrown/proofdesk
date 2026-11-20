import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { createConnectionService } from "../src/server/connections/service.js";
import { readDemoSeed, seedDemo } from "../src/server/demo.js";
import { buildKey, parseKey } from "../src/server/tickets/keys.js";
import { createPublicFields, toEntry } from "../src/server/tickets/public-fields.js";
import * as repository from "../src/server/tickets/repository.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne } from "./helpers.js";

// What each viewer sees of a ticket in the rare cases: an assistant with no connection, a demo
// assistant on a sample that is not its own, and rows written before a field was kept.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

function desk() {
  const { db, config } = buildTestApp();
  const tickets = createTicketService(db, config.ticketPrefix);
  const fields = createPublicFields(db, config.ticketPrefix);
  const { key } = tickets.createTicket(valid, customerOne);
  const row = repository.findTicket(db, parseKey(config.ticketPrefix, key)!)!;
  return { db, config, tickets, fields, key, row };
}

function demoDesk() {
  const { db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const tickets = createTicketService(db, config.ticketPrefix);
  seedDemo(tickets);
  const connections = createConnectionService(db, () => true);
  const agent = connections.authenticate(connections.issueDemo().key)!;
  const fields = createPublicFields(db, config.ticketPrefix);
  return { db, config, tickets, agent, fields, seed: readDemoSeed(db)! };
}

describe("which connection a ticket is handed to", () => {
  it("is nothing for an assistant that came through no connection", () => {
    const { fields, row } = desk();
    const loose: Actor = { id: "agent-1", kind: "agent", role: "team", name: "Loose" };
    expect(fields.toTicket(row, loose).agent_id).toBeNull();
  });

  it("is a demo assistant's own connection on the assistants' sample, and nothing on others", () => {
    const { db, agent, fields, seed } = demoDesk();
    const own = String(agent.connection!.id);
    expect(isDemo(agent)).toBe(true);
    const sample = repository.findTicket(db, seed.assistant!)!;
    expect(fields.toTicket(sample, agent).agent_id).toBe(own);
    const other = seed.tickets.find((id) => id !== seed.assistant)!;
    expect(fields.toTicket(repository.findTicket(db, other)!, agent).agent_id).toBeNull();
  });
});

const isDemo = (actor: Actor) => actor.kind === "agent" && actor.demo === true;

describe("a demo assistant's view of a ticket's text", () => {
  it("shows the sample text as first written", () => {
    const { db, config, tickets, agent, fields, seed } = demoDesk();
    const id = seed.assistant!;
    const key = buildKey(config.ticketPrefix, id);
    const first = seed.text[String(id)]!;
    db.prepare("UPDATE tickets SET title = ? WHERE id = ?").run("Changed by a visitor", id);
    expect(tickets.getTicket(key, adminActor).title).toBe("Changed by a visitor");
    expect(fields.toTicket(repository.findTicket(db, id)!, agent).title).toBe(first.title);
  });

  it("shows a ticket with no first-written text as it is", () => {
    const { db, config, tickets, agent, fields } = demoDesk();
    const { key } = tickets.createTicket(valid, adminActor);
    const row = repository.findTicket(db, parseKey(config.ticketPrefix, key)!)!;
    expect(fields.toTicket(row, agent).title).toBe(valid.title);
  });
});

describe("rows written before a field was kept", () => {
  it("shows a note with no stored purpose as a note, and gives a reply no purpose", () => {
    const base = {
      id: 1,
      ticket_id: 1,
      body: "Looked at the tray.",
      author: adminActor.id,
      author_kind: "person" as const,
      author_role: "admin" as const,
      author_name: adminActor.name,
      created_at: "2026-01-05T10:00:00.000Z",
    };
    expect(toEntry({ ...base, kind: "note" }).purpose).toBe("note");
    expect(toEntry({ ...base, kind: "reply" }).purpose).toBeNull();
    expect(toEntry({ ...base, kind: "note" }).based_on).toBeNull();
  });

  it("shows a question asked with no evidence list as choosing no evidence", () => {
    const { fields, row } = desk();
    const asked = { ...row, ready_at: "2026-01-05T10:00:00.000Z", ready_evidence: null };
    expect(fields.toTicket(asked, adminActor).ask?.evidence_ids).toEqual([]);
  });
});

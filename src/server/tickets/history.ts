import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { requireRoom } from "./checks.js";
import * as repository from "./repository.js";
import type { Budget } from "./types.js";

// Writing a ticket's history, and the small changes several actions share. Each change writes
// its history entry in the transaction of the action that calls it.

/** The fields of a ticket that is not waiting for the customer's answer. */
export const noQuestion = { ready_at: null, ready_token: null };

/**
 * What an agent's history entry records beside its id: which connection, who issued it, and
 * the scopes it held at that moment. Null for a person.
 */
export function agentContext(actor: Actor): object | null {
  if (actor.kind !== "agent" || actor.connection === undefined) return null;
  return {
    connection_id: actor.connection.id,
    connection_name: actor.connection.name,
    issued_by: actor.connection.issuedBy,
    scopes: actor.scopes ?? [],
  };
}

export function createHistory(db: Db, budget: Budget) {
  /** Writes a history entry, within the budget of events per ticket. */
  function logEvent(event: repository.NewEvent): void {
    requireRoom(
      () => repository.countRows(db, "ticket_events", event.ticketId),
      budget.eventsPerTicket,
      "changes to this ticket",
    );
    // An agent's action also records the ticket's human owner at that moment.
    const context = event.context
      ? { ...event.context, ticket_owner: repository.ownerOf(db, event.ticketId) }
      : null;
    repository.insertEvent(db, { ...event, context });
  }

  /**
   * Writes a history entry for something this actor did: who did it, as a person or an agent,
   * and for an agent its connection.
   */
  function log(ticketId: number, actor: Actor, type: string, data: object, now: string): void {
    logEvent({
      ticketId,
      actor: actor.id,
      actorKind: actor.kind,
      context: agentContext(actor),
      type,
      data,
      now,
    });
  }

  /** Changes the owner and writes the history entry. Call it inside a transaction. */
  function setOwner(
    before: repository.TicketRow,
    ownerId: string | null,
    ownerName: string | null,
    actor: Actor,
  ): repository.TicketRow {
    const now = new Date().toISOString();
    repository.updateTicketOwner(db, before.id, ownerId, ownerName, now);
    log(before.id, actor, "owner_changed", { from: before.owner_name, to: ownerName }, now);
    return { ...before, owner_id: ownerId, owner_name: ownerName, updated_at: now };
  }

  /** Ends the ticket's agent hand-off, if any, and says so in the history. */
  function endAgent(row: repository.TicketRow, reason: string, actor: Actor, now: string): void {
    const ended = repository.endHandoff(db, row.id, reason, now);
    if (ended === undefined) return;
    log(row.id, actor, "agent_handoff_ended", { connection: ended, reason }, now);
  }

  /**
   * Withdraws the customer's question when what it was about changes (the ticket's text, the
   * agreed check or the change link), or when the ticket is handed off or archived. Call it
   * inside the transaction of that change. It writes no history entry of its own: the change
   * it belongs to writes one.
   */
  function withdrawQuestion(before: repository.TicketRow): void {
    // Each of those changes writes its own updated_at right after.
    if (before.ready_at !== null) repository.clearReady(db, before.id, new Date().toISOString());
  }

  return { logEvent, log, setOwner, endAgent, withdrawQuestion };
}

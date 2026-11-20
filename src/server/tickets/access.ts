import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { requireDemoSeed } from "../demo.js";
import { HttpError } from "../errors.js";
import { can } from "../permissions.js";
import { parseKey } from "./keys.js";
import * as repository from "./repository.js";
import type { ListNarrowing } from "./types.js";
import { listSearchMatch } from "./word-query.js";

// Which tickets an actor may reach, and the ticket row behind a key.
//
// On the public demo, many visitors share the sample tickets, and each may connect their own
// assistant. An assistant must never read text another visitor wrote, or one visitor could
// plant instructions for another visitor's assistant. So a demo connection sees only the
// sample tickets, with their text as first written, and what that same connection wrote.

/** An assistant connected to the public demo. */
export function isDemoAgent(actor: Actor | undefined): boolean {
  return actor !== undefined && actor.kind === "agent" && actor.demo === true;
}

/** An agent outside the demo, which sees only the tickets handed to its connection. */
export function isHandedAgent(actor: Actor): boolean {
  return actor.kind === "agent" && actor.demo !== true && actor.connection !== undefined;
}

/** How much an assistant is asked for ways to verify a ticket, as an admin set it. */
export type SuggestionSetting = "off" | "when_asked" | "automatic";

/**
 * A connection's suggestion setting, from its scopes. Off for a person, for a demo connection,
 * so the demo takes no text from strangers into a customer's page, and for a connection that
 * may not read the tickets, since it suggests from what it reads.
 */
export function suggestionSetting(actor: Actor): SuggestionSetting {
  const scopes = actor.scopes ?? [];
  if (!isHandedAgent(actor) || !scopes.includes("read_tickets")) return "off";
  if (scopes.includes("suggest_automatic") && scopes.includes("suggest_when_asked")) {
    return "automatic";
  }
  if (scopes.includes("suggest_when_asked")) return "when_asked";
  return "off";
}

/**
 * An assistant set to Automatic: it may read the New tickets that have no check and suggest
 * ways to verify them unasked.
 */
export function maySuggestChecks(actor: Actor): boolean {
  return suggestionSetting(actor) === "automatic";
}

/** A ticket waiting for a way to verify it: New, not archived, and no check from the customer. */
export function wantsCheck(row: repository.TicketRow): boolean {
  return row.status === "new" && row.archived_at === null && row.fix_check === null;
}

/** The owner filter and search as the repository reads them. */
export function narrowed(narrowing: ListNarrowing, actor: Actor): repository.Narrowing {
  return {
    ownerId: narrowing.owner === "me" ? actor.id : null,
    unassigned: narrowing.owner === "none",
    // Searched as plain text: %, _ and \ in it mean themselves.
    search: narrowing.q ? `%${narrowing.q.replace(/[\\%_]/g, "\\$&")}%` : null,
    // And searched as words, in any order and any form.
    match: narrowing.q ? listSearchMatch(narrowing.q) : null,
    // Only the list page leaves older resolved tickets out, and it says so itself.
    resolvedSince: null,
  };
}

export function createAccess(db: Db, prefix: string) {
  /**
   * The tickets a demo connection works on: the sample made for assistants, handed to every
   * visitor's connection. A seed recorded before it was named falls back to every sample.
   */
  function demoTicketIds(): number[] {
    const seed = requireDemoSeed(db);
    return seed.assistant !== undefined ? [seed.assistant] : seed.tickets;
  }

  /** Turns a key into a number or throws 400. Does not check the ticket exists. */
  function idFromKey(key: string): number {
    const id = parseKey(prefix, key);
    if (id === null) {
      // A fixed message: echoing the key would let anyone put their own text on a page.
      throw new HttpError(400, "invalid_key", "That is not a valid ticket key.");
    }
    return id;
  }

  /**
   * Returns the ticket row if it exists and this actor may see it. Otherwise throws 404, the
   * same whether the ticket does not exist or is someone else's, so the answer does not reveal
   * that someone else's ticket exists. Only someone who may list every ticket is told, with 410,
   * that a ticket was deleted.
   */
  function requireRow(key: string, actor: Actor): repository.TicketRow {
    const id = idFromKey(key);
    if (isDemoAgent(actor) && !demoTicketIds().includes(id)) {
      throw new HttpError(404, "ticket_not_found", `No ticket ${key}.`);
    }
    // An agent works only on the tickets handed to its connection.
    if (
      isHandedAgent(actor) &&
      !repository.handedTicketIds(db, actor.connection!.id).includes(id)
    ) {
      throw new HttpError(404, "ticket_not_found", `No ticket ${key}.`);
    }
    const row = repository.findTicket(db, id);
    // The team is told a ticket was deleted on purpose. A customer gets the usual answer.
    if (row === undefined && can(actor, "list_all") && repository.wasDeleted(db, id)) {
      throw new HttpError(410, "ticket_deleted", `Ticket ${key} was deleted permanently.`);
    }
    if (row === undefined || !can(actor, "read", row)) {
      throw new HttpError(404, "ticket_not_found", `No ticket ${key}.`);
    }
    return row;
  }

  /**
   * The row of a ticket waiting for a way to verify it, for an assistant allowed to suggest
   * one. Any other ticket, and any other caller, gets the same 404 as a ticket that does not
   * exist, so the answer says nothing more about it.
   */
  function requireRowWantingCheck(key: string, actor: Actor): repository.TicketRow {
    const id = idFromKey(key);
    const row = repository.findTicket(db, id);
    if (!maySuggestChecks(actor) || row === undefined || !wantsCheck(row)) {
      throw new HttpError(404, "ticket_not_found", `No ticket ${key}.`);
    }
    return row;
  }

  /**
   * Whether a keyed retry may be given its saved answer: the caller must still reach the ticket
   * by the door the action itself uses. Most actions read the ticket as usual. Suggesting ways
   * to verify also reaches a New ticket with no check. A customer who archived their own ticket
   * no longer reads it, but the saved answer was made for them, so their retry still gets it.
   * Otherwise this throws the refusal the same write without a key would get.
   */
  function requireRowForRetry(key: string, actor: Actor, action: string): void {
    try {
      requireRow(key, actor);
      return;
    } catch (err) {
      if (action === "suggest_checks") {
        requireRowWantingCheck(key, actor);
        return;
      }
      if (action === "archive_ticket") {
        const row = repository.findTicket(db, idFromKey(key));
        if (row !== undefined && row.archived_at !== null && row.created_by === actor.id) return;
      }
      throw err;
    }
  }

  /**
   * Whose tickets this viewer's lists hold, decided once for both the rows and the counts. The
   * team gets everyone's. An assistant gets only its own: the ones handed to its connection, or
   * on the demo the sample made for assistants. They are picked in SQL before the page is cut,
   * so newer tickets never push them off a page. A customer gets the ones they filed, and an
   * assistant files none, so for one that list is empty.
   */
  function visibleScope(actor: Actor): repository.ListScope {
    if (!can(actor, "list_all")) return { kind: "filed_by", createdBy: actor.id };
    if (isHandedAgent(actor)) {
      const ids = repository.handedTicketIds(db, actor.connection!.id);
      // One allowed to suggest ways to verify also lists the New tickets that have no check.
      if (maySuggestChecks(actor)) return { kind: "among_or_wanting_check", ids };
      return { kind: "among", ids };
    }
    if (isDemoAgent(actor)) return { kind: "among", ids: demoTicketIds() };
    return { kind: "everyone" };
  }

  return { idFromKey, requireRow, requireRowWantingCheck, requireRowForRetry, visibleScope };
}

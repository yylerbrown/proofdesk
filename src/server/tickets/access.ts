import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { requireDemoSeed } from "../demo.js";
import { HttpError } from "../errors.js";
import { can } from "../permissions.js";
import { parseKey } from "./keys.js";
import * as repository from "./repository.js";
import type { ListNarrowing } from "./types.js";

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

/** The owner filter and search as the repository reads them. */
export function narrowed(narrowing: ListNarrowing, actor: Actor): repository.Narrowing {
  return {
    ownerId: narrowing.owner === "me" ? actor.id : null,
    unassigned: narrowing.owner === "none",
    // Searched as plain words: %, _ and \ in them mean themselves.
    search: narrowing.q ? `%${narrowing.q.replace(/[\\%_]/g, "\\$&")}%` : null,
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
   * Whose tickets this viewer's lists hold, decided once for both the rows and the counts. The
   * team gets everyone's. An assistant gets only its own: the ones handed to its connection, or
   * on the demo the sample made for assistants. They are picked in SQL before the page is cut,
   * so newer tickets never push them off a page. A customer gets the ones they filed, and an
   * assistant files none, so for one that list is empty.
   */
  function visibleScope(actor: Actor): repository.ListScope {
    if (!can(actor, "list_all")) return { kind: "filed_by", createdBy: actor.id };
    if (isHandedAgent(actor)) {
      return { kind: "among", ids: repository.handedTicketIds(db, actor.connection!.id) };
    }
    if (isDemoAgent(actor)) return { kind: "among", ids: demoTicketIds() };
    return { kind: "everyone" };
  }

  return { idFromKey, requireRow, visibleScope };
}

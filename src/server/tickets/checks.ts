import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { forbidden, HttpError } from "../errors.js";
import { can, type Action } from "../permissions.js";
import * as repository from "./repository.js";

// Checks that many ticket actions make before they write, each a plain function.

/** Throws 403 unless the actor may do this action, on this ticket if one is given. */
export function requirePermission(actor: Actor, action: Action, row?: repository.TicketRow): void {
  if (!can(actor, action, row)) {
    throw forbidden(actor);
  }
}

/** Throws 409 when the ticket is archived. Used before any change to its content. */
export function requireNotArchived(key: string, row: repository.TicketRow): void {
  if (row.archived_at !== null) {
    throw new HttpError(409, "ticket_archived", `Ticket ${key} is archived. Restore it first.`);
  }
}

/** Throws 409 when a budget is used up. Counts only when there is a budget to count against. */
export function requireRoom(count: () => number, most: number | undefined, what: string): void {
  if (most !== undefined && count() >= most) {
    throw new HttpError(409, "budget_full", `This server holds no more ${what}.`);
  }
}

/**
 * Throws 409 when the caller says which version it saw and the ticket has changed since, so a
 * change made from an old page or an old read never writes over a newer one. A caller that
 * sends no version is not checked. Every action decides first what it can decide without the
 * version: who may do it, whether the ticket's state allows it, and whether it is a repeat that
 * changes nothing. It checks the version last, just before it writes. So the second press of a
 * double click is never refused for its version, and a refusal for the ticket's state keeps
 * its own words.
 */
export function requireVersion(key: string, row: repository.TicketRow, expected?: number): void {
  if (expected === undefined || expected === row.version) return;
  throw new HttpError(
    409,
    "ticket_changed",
    `Ticket ${key} changed since you opened it, so nothing was saved.`,
  );
}

/**
 * A changed ticket's row with the version the database gave it. A change builds its answer
 * from the row it read, and the database raises the version as the change is written.
 */
export function saved(db: Db, row: repository.TicketRow): repository.TicketRow {
  return { ...row, version: repository.versionOf(db, row.id) ?? row.version };
}

import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { parse } from "../validation.js";
import { buildKey, parseKey } from "./keys.js";
import * as repository from "./repository.js";
import {
  changeStatusSchema,
  createTicketSchema,
  type TicketListFilter,
  type TicketStatus,
} from "./schemas.js";

// The rules for tickets live here: what a valid ticket is, key handling, "not found",
// "same status is a no-op", and which writes must happen together in one transaction.
// Routes and pages call these functions and nothing else. Input that comes from outside
// arrives as "unknown" and is checked here, so no caller can skip the check.

/** What callers see. The bare database number is replaced by the public key. */
export type Ticket = {
  key: string;
  title: string;
  description: string;
  status: TicketStatus;
  where_url: string | null;
  fix_check: string | null;
  created_by: string | null;
  owner_id: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type TicketEvent = {
  id: number;
  ticket_key: string;
  actor: string;
  actor_kind: repository.ActorKind;
  type: string;
  data: unknown;
  created_at: string;
};

export type TicketService = ReturnType<typeof createTicketService>;

const PREFIX_META_KEY = "ticket_prefix";

/**
 * Keys such as SUP-42 are built from the prefix on every read, so the prefix must never
 * change for a database that already has tickets. The first start writes the prefix into
 * the database. Every later start must be configured with the same one.
 */
function pinPrefix(db: Db, prefix: string): void {
  const stored = repository.getMeta(db, PREFIX_META_KEY);
  if (stored === undefined) {
    repository.insertMeta(db, PREFIX_META_KEY, prefix);
    return;
  }
  if (stored !== prefix) {
    throw new Error(
      `TICKET_PREFIX is "${prefix}" but this database was created with "${stored}". ` +
        `Set TICKET_PREFIX back to "${stored}".`,
    );
  }
}

export function createTicketService(db: Db, prefix: string) {
  pinPrefix(db, prefix);

  // Every public field is named here. A column added to the table later stays private
  // until someone adds it to this list on purpose.
  function toTicket(row: repository.TicketRow): Ticket {
    return {
      key: buildKey(prefix, row.id),
      title: row.title,
      description: row.description,
      status: row.status,
      where_url: row.where_url,
      fix_check: row.fix_check,
      created_by: row.created_by,
      owner_id: row.owner_id,
      agent_id: row.agent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
    };
  }

  function toEvent(row: repository.EventRow): TicketEvent {
    return {
      id: row.id,
      ticket_key: buildKey(prefix, row.ticket_id),
      actor: row.actor,
      actor_kind: row.actor_kind,
      type: row.type,
      data: JSON.parse(row.data),
      created_at: row.created_at,
    };
  }

  /** Turns a key into a number or throws 400. Does not check the ticket exists. */
  function idFromKey(key: string): number {
    const id = parseKey(prefix, key);
    if (id === null) {
      throw new HttpError(400, "invalid_key", `"${key}" is not a valid ticket key.`);
    }
    return id;
  }

  /** Returns the ticket row or throws 404. */
  function requireRow(key: string): repository.TicketRow {
    const row = repository.findTicket(db, idFromKey(key));
    if (row === undefined) {
      throw new HttpError(404, "ticket_not_found", `No ticket ${key}.`);
    }
    return row;
  }

  /** Returns the ticket row, or throws 404 if it is missing and 409 if it is archived. */
  function requireActiveRow(key: string): repository.TicketRow {
    const row = requireRow(key);
    if (row.archived_at !== null) {
      throw new HttpError(409, "ticket_archived", `Ticket ${key} is archived. Restore it first.`);
    }
    return row;
  }

  return {
    /** Checks the input, then saves the ticket and its "created" event together. */
    createTicket(input: unknown, actor: Actor): Ticket {
      const ticket = parse(createTicketSchema, input);
      const now = new Date().toISOString();
      const row = db.transaction(() => {
        const id = repository.insertTicket(db, {
          title: ticket.title,
          description: ticket.description,
          whereUrl: ticket.where_url ?? null,
          fixCheck: ticket.fix_check || null,
          now,
        });
        repository.insertEvent(db, {
          ticketId: id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "created",
          data: { status: "new" },
          now,
        });
        return repository.findTicket(db, id)!;
      })();
      return toTicket(row);
    },

    /** "archived" lists only archived tickets. Every other filter leaves them out. */
    listTickets(filter: TicketListFilter): Ticket[] {
      if (filter === "archived") return repository.listArchivedTickets(db).map(toTicket);
      const status = filter === "all" ? undefined : filter;
      return repository.listTickets(db, status).map(toTicket);
    },

    getTicket(key: string): Ticket {
      return toTicket(requireRow(key));
    },

    /** Checks the input, then saves the new status and its event together. */
    changeStatus(key: string, input: unknown, actor: Actor): Ticket {
      const { status } = parse(changeStatusSchema, input);
      const row = db.transaction(() => {
        const before = requireActiveRow(key);
        if (before.status === status) return before; // nothing changes, so nothing is logged
        const now = new Date().toISOString();
        repository.updateTicketStatus(db, before.id, status, now);
        repository.insertEvent(db, {
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "status_changed",
          data: { from: before.status, to: status },
          now,
        });
        return { ...before, status, updated_at: now };
      })();
      return toTicket(row);
    },

    /**
     * Replaces the text of a ticket: title, description, link and check. The input has the
     * same shape and rules as a new ticket. The event records each field that changed, with
     * its old and new value. If nothing changed, nothing is written.
     */
    editTicket(key: string, input: unknown, actor: Actor): Ticket {
      const ticket = parse(createTicketSchema, input);
      const after = {
        title: ticket.title,
        description: ticket.description,
        where_url: ticket.where_url ?? null,
        fix_check: ticket.fix_check || null,
      };
      const row = db.transaction(() => {
        const before = requireActiveRow(key);
        const changes: Record<string, { from: string | null; to: string | null }> = {};
        for (const field of ["title", "description", "where_url", "fix_check"] as const) {
          if (before[field] !== after[field]) {
            changes[field] = { from: before[field], to: after[field] };
          }
        }
        if (Object.keys(changes).length === 0) return before;
        const now = new Date().toISOString();
        repository.updateTicketText(
          db,
          before.id,
          {
            title: after.title,
            description: after.description,
            whereUrl: after.where_url,
            fixCheck: after.fix_check,
          },
          now,
        );
        repository.insertEvent(db, {
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "edited",
          data: { changes },
          now,
        });
        return { ...before, ...after, updated_at: now };
      })();
      return toTicket(row);
    },

    /** Hides the ticket from the ordinary lists. Its row and its events are kept. */
    archiveTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key);
        if (before.archived_at !== null) return before; // already archived
        const now = new Date().toISOString();
        repository.updateTicketArchived(db, before.id, now, now);
        repository.insertEvent(db, {
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "archived",
          data: {},
          now,
        });
        return { ...before, archived_at: now, updated_at: now };
      })();
      return toTicket(row);
    },

    /** Brings an archived ticket back into the ordinary lists. */
    restoreTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key);
        if (before.archived_at === null) return before; // not archived
        const now = new Date().toISOString();
        repository.updateTicketArchived(db, before.id, null, now);
        repository.insertEvent(db, {
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "restored",
          data: {},
          now,
        });
        return { ...before, archived_at: null, updated_at: now };
      })();
      return toTicket(row);
    },

    listEvents(key: string): TicketEvent[] {
      const row = requireRow(key);
      return repository.listEvents(db, row.id).map(toEvent);
    },
  };
}

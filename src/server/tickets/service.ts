import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { HttpError, ValidationError } from "../errors.js";
import { can, type Action } from "../permissions.js";
import { parse } from "../validation.js";
import { buildKey, parseKey } from "./keys.js";
import * as repository from "./repository.js";
import {
  addEntrySchema,
  changeStatusSchema,
  createTicketSchema,
  deleteTicketSchema,
  type TicketListFilter,
  type TicketStatus,
} from "./schemas.js";

// The rules for tickets live here: what a valid ticket is, key handling, "not found",
// "same status is a no-op", and which writes must happen together in one transaction.
// Routes and pages call these functions and nothing else. Input that comes from outside
// arrives as "unknown" and is checked here, so no caller can skip the check. Every function
// takes the actor and asks can() in permissions.ts, so no caller can skip that either.

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

/** One entry of the conversation on a ticket, as callers see it. */
export type TicketEntry = {
  id: number;
  kind: "reply" | "note";
  body: string;
  author: string;
  author_kind: repository.ActorKind;
  author_role: "customer" | "team" | "admin";
  author_name: string;
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

  function toEntry(row: repository.EntryRow): TicketEntry {
    return {
      id: row.id,
      kind: row.kind,
      body: row.body,
      author: row.author,
      author_kind: row.author_kind,
      author_role: row.author_role,
      author_name: row.author_name,
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

  /**
   * Returns the ticket row if it exists and this actor may see it. Otherwise throws the same
   * 404 in both cases, so the answer does not reveal that someone else's ticket exists.
   */
  function requireRow(key: string, actor: Actor): repository.TicketRow {
    const id = idFromKey(key);
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

  /** Throws 403 unless the actor may do this action, on this ticket if one is given. */
  function requirePermission(actor: Actor, action: Action, row?: repository.TicketRow): void {
    if (!can(actor, action, row)) {
      throw new HttpError(403, "forbidden", "You are not allowed to do that.");
    }
  }

  /** Throws 409 when the ticket is archived. Used before any change to its content. */
  function requireNotArchived(key: string, row: repository.TicketRow): void {
    if (row.archived_at !== null) {
      throw new HttpError(409, "ticket_archived", `Ticket ${key} is archived. Restore it first.`);
    }
  }

  return {
    /** Checks the input, then saves the ticket and its "created" event together. */
    createTicket(input: unknown, actor: Actor): Ticket {
      requirePermission(actor, "create");
      const ticket = parse(createTicketSchema, input);
      const now = new Date().toISOString();
      const row = db.transaction(() => {
        const id = repository.insertTicket(db, {
          title: ticket.title,
          description: ticket.description,
          whereUrl: ticket.where_url ?? null,
          fixCheck: ticket.fix_check || null,
          createdBy: actor.id,
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

    /**
     * A team member or admin gets every ticket. A customer gets only the ones they filed.
     * "archived" lists only archived tickets, for a team member or admin. Every other filter leaves
     * archived tickets out.
     */
    listTickets(filter: TicketListFilter, actor: Actor): Ticket[] {
      if (filter === "archived") {
        requirePermission(actor, "list_archived");
        return repository.listArchivedTickets(db).map(toTicket);
      }
      const status = filter === "all" ? null : filter;
      const createdBy = can(actor, "list_all") ? null : actor.id;
      return repository.listTickets(db, status, createdBy).map(toTicket);
    },

    getTicket(key: string, actor: Actor): Ticket {
      return toTicket(requireRow(key, actor));
    },

    /** Checks the input, then saves the new status and its event together. */
    changeStatus(key: string, input: unknown, actor: Actor): Ticket {
      const { status } = parse(changeStatusSchema, input);
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "change_status", before);
        requireNotArchived(key, before);
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
        const before = requireRow(key, actor);
        requirePermission(actor, "edit", before);
        requireNotArchived(key, before);
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
        const before = requireRow(key, actor);
        requirePermission(actor, "archive", before);
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

    /** Brings an archived ticket back into the ordinary lists. Not for customers. */
    restoreTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "restore", before);
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

    /** The history, oldest first. Someone who may not read notes does not see them added. */
    listEvents(key: string, actor: Actor): TicketEvent[] {
      const row = requireRow(key, actor);
      const events = repository.listEvents(db, row.id).map(toEvent);
      if (can(actor, "read_notes", row)) return events;
      return events.filter((event) => event.type !== "note_added");
    },

    /**
     * Adds a reply or an internal note, and its history entry, together. The history entry
     * says only that something was added. The text itself lives in the entry.
     */
    addEntry(key: string, input: unknown, actor: Actor): TicketEntry {
      const entry = parse(addEntrySchema, input);
      const row = db.transaction(() => {
        const ticket = requireRow(key, actor);
        requirePermission(actor, entry.kind === "note" ? "note" : "reply", ticket);
        requireNotArchived(key, ticket);
        const now = new Date().toISOString();
        const saved = repository.insertEntry(db, {
          ticket_id: ticket.id,
          kind: entry.kind,
          body: entry.body,
          author: actor.id,
          author_kind: actor.kind,
          author_role: actor.role,
          author_name: actor.name,
          created_at: now,
        });
        repository.insertEvent(db, {
          ticketId: ticket.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: entry.kind === "note" ? "note_added" : "reply_added",
          data: {},
          now,
        });
        return saved;
      })();
      return toEntry(row);
    },

    /** The conversation, oldest first. Internal notes only for those who may read them. */
    listEntries(key: string, actor: Actor): TicketEntry[] {
      const row = requireRow(key, actor);
      const includeNotes = can(actor, "read_notes", row);
      return repository.listEntries(db, row.id, includeNotes).map(toEntry);
    },

    /**
     * Deletes the ticket and everything that belongs to it, for good. Only its number, the
     * time and who did it are kept. The input must repeat the ticket's key, so that it
     * cannot happen by a slip.
     */
    deleteTicket(key: string, input: unknown, actor: Actor): void {
      const { confirm } = parse(deleteTicketSchema, input);
      db.transaction(() => {
        const row = requireRow(key, actor);
        requirePermission(actor, "delete", row);
        const exactKey = buildKey(prefix, row.id);
        if (confirm !== exactKey) {
          throw new ValidationError(`Type ${exactKey} to confirm.`, {
            confirm: [`Type ${exactKey} to confirm.`],
          });
        }
        repository.deleteTicketForever(db, row.id, actor.id, new Date().toISOString());
      })();
      repository.flushDeletedContent(db);
    },

    /** What this actor may do to this ticket, for a page to decide which controls to show. */
    allowedActions(ticket: Ticket, actor: Actor) {
      const archived = ticket.archived_at !== null;
      return {
        edit: !archived && can(actor, "edit", ticket),
        changeStatus: !archived && can(actor, "change_status", ticket),
        archive: !archived && can(actor, "archive", ticket),
        restore: archived && can(actor, "restore", ticket),
        delete: can(actor, "delete", ticket),
        reply: !archived && can(actor, "reply", ticket),
        note: !archived && can(actor, "note", ticket),
      };
    },
  };
}

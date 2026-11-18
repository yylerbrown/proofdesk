import { randomUUID } from "node:crypto";
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
  agreeCheckSchema,
  answerSchema,
  linkChangeSchema,
  markReadySchema,
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
  agreed_check: string | null;
  created_by: string | null;
  owner_id: string | null;
  owner_name: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  change_url: string | null;
  try_url: string | null;
  ready_at: string | null;
  ready_token: string | null;
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

/** Most rows the service will hold. Leave a field out for no limit. */
export type Budget = { tickets?: number; entriesPerTicket?: number; eventsPerTicket?: number };

/** The demo's budget: enough to try everything, too little to fill the disk. */
export const DEMO_BUDGET: Budget = { tickets: 200, entriesPerTicket: 50, eventsPerTicket: 100 };

/** How many tickets a list page shows, and how many entries or events a ticket page shows. */
export const LIST_PAGE_SIZE = 100;
export const THREAD_LIMIT = 200;

// The fields of a ticket that is not waiting for the customer's answer.
const noQuestion = { ready_at: null, ready_token: null };

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

export function createTicketService(db: Db, prefix: string, budget: Budget = {}) {
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
      agreed_check: row.agreed_check,
      created_by: row.created_by,
      owner_id: row.owner_id,
      owner_name: row.owner_name,
      agent_id: row.agent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      archived_at: row.archived_at,
      change_url: row.change_url,
      try_url: row.try_url,
      ready_at: row.ready_at,
      ready_token: row.ready_token,
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
      // A fixed message: echoing the key would let anyone put their own text on a page.
      throw new HttpError(400, "invalid_key", "That is not a valid ticket key.");
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

  /** Changes the owner and writes the history entry. Call it inside a transaction. */
  function setOwner(
    before: repository.TicketRow,
    ownerId: string | null,
    ownerName: string | null,
    actor: Actor,
  ): repository.TicketRow {
    const now = new Date().toISOString();
    repository.updateTicketOwner(db, before.id, ownerId, ownerName, now);
    logEvent({
      ticketId: before.id,
      actor: actor.id,
      actorKind: actor.kind,
      type: "owner_changed",
      data: { from: before.owner_name, to: ownerName },
      now,
    });
    return { ...before, owner_id: ownerId, owner_name: ownerName, updated_at: now };
  }

  /**
   * Withdraws the customer's question when what it was about changes: the ticket's text,
   * the agreed check or the change link. Call it inside the transaction of that change.
   */
  function withdrawQuestion(before: repository.TicketRow): void {
    if (before.ready_at !== null) repository.clearReady(db, before.id);
  }

  /** Throws 409 when a budget is used up. */
  function requireRoom(used: number, most: number | undefined, what: string): void {
    if (most !== undefined && used >= most) {
      throw new HttpError(409, "budget_full", `This server holds no more ${what}.`);
    }
  }

  /** Writes a history entry, within the budget of events per ticket. */
  function logEvent(event: repository.NewEvent): void {
    requireRoom(
      repository.countRows(db, "ticket_events", event.ticketId),
      budget.eventsPerTicket,
      "changes to this ticket",
    );
    repository.insertEvent(db, event);
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
        requireRoom(repository.countTickets(db), budget.tickets, "tickets");
        const id = repository.insertTicket(db, {
          title: ticket.title,
          description: ticket.description,
          whereUrl: ticket.where_url ?? null,
          fixCheck: ticket.fix_check || null,
          createdBy: actor.id,
          now,
        });
        logEvent({
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
    listTickets(filter: TicketListFilter, actor: Actor, pageNumber = 1): Ticket[] {
      const page = { limit: LIST_PAGE_SIZE, offset: (pageNumber - 1) * LIST_PAGE_SIZE };
      if (filter === "archived") {
        requirePermission(actor, "list_archived");
        return repository.listArchivedTickets(db, page).map(toTicket);
      }
      const status = filter === "all" ? null : filter;
      if (can(actor, "list_all")) return repository.listAllTickets(db, status, page).map(toTicket);
      return repository.listTicketsFiledBy(db, actor.id, status, page).map(toTicket);
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
        if (status === "resolved") {
          throw new HttpError(
            409,
            "needs_customer",
            `Only the customer resolves ticket ${key}, by answering "Did this fix it?".`,
          );
        }
        if (status === "in_progress" && before.owner_id === null) {
          throw new HttpError(
            409,
            "needs_owner",
            `Take ticket ${key} before moving it to In Progress.`,
          );
        }
        const now = new Date().toISOString();
        repository.updateTicketStatus(db, before.id, status, now);
        logEvent({
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "status_changed",
          data: { from: before.status, to: status },
          now,
        });
        return { ...before, status, ready_at: null, ready_token: null, updated_at: now };
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
        withdrawQuestion(before);
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
        logEvent({
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "edited",
          data: { changes },
          now,
        });
        return { ...before, ...after, ...noQuestion, updated_at: now };
      })();
      return toTicket(row);
    },

    /**
     * Sets the agreed version of the customer's check, or removes it with an empty text. The
     * customer's own words in fix_check are never changed by this.
     */
    agreeCheck(key: string, input: unknown, actor: Actor): Ticket {
      const { agreed_check } = parse(agreeCheckSchema, input);
      const agreed = agreed_check === "" ? null : agreed_check;
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "agree_check", before);
        requireNotArchived(key, before);
        if (before.agreed_check === agreed) return before; // nothing changes
        const now = new Date().toISOString();
        withdrawQuestion(before);
        repository.updateAgreedCheck(db, before.id, agreed, now);
        logEvent({
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "check_agreed",
          data: { from: before.agreed_check, to: agreed },
          now,
        });
        return { ...before, agreed_check: agreed, ...noQuestion, updated_at: now };
      })();
      return toTicket(row);
    },

    /** Records the link to the code change. Evidence, not proof that the ticket is fixed. */
    linkChange(key: string, input: unknown, actor: Actor): Ticket {
      const { change_url } = parse(linkChangeSchema, input);
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "link_change", before);
        requireNotArchived(key, before);
        if (before.change_url === change_url) return before;
        const now = new Date().toISOString();
        withdrawQuestion(before);
        repository.updateChangeUrl(db, before.id, change_url, now);
        logEvent({
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "change_linked",
          data: { from: before.change_url, to: change_url },
          now,
        });
        return { ...before, change_url, ...noQuestion, updated_at: now };
      })();
      return toTicket(row);
    },

    /**
     * After the change is live and a team member has checked it, asks the customer "Did
     * this fix it?", pointing them at the page to try. The ticket must be in progress (so it
     * has an owner) and have its change link.
     */
    markReady(key: string, input: unknown, actor: Actor): Ticket {
      const { try_url } = parse(markReadySchema, input);
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "mark_ready", before);
        requireNotArchived(key, before);
        if (before.status !== "in_progress") {
          throw new HttpError(409, "not_in_progress", `Move ticket ${key} to In Progress first.`);
        }
        if (before.change_url === null) {
          throw new HttpError(409, "needs_change_link", `Add the change link to ${key} first.`);
        }
        // Already waiting for an answer: asking again changes nothing and writes nothing.
        if (before.ready_at !== null) return before;
        const now = new Date().toISOString();
        const token = randomUUID();
        repository.updateReady(db, before.id, try_url, token, now);
        logEvent({
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "ready_for_customer",
          data: { try_url },
          now,
        });
        return { ...before, try_url, ready_at: now, ready_token: token, updated_at: now };
      })();
      return toTicket(row);
    },

    /**
     * The customer's answer to "Did this fix it?". Yes resolves the ticket. No puts it back
     * in progress with its owner, and the customer's comment goes into the conversation.
     */
    answer(key: string, input: unknown, actor: Actor): Ticket {
      const { fixed, comment, ready_token } = parse(answerSchema, input);
      if (fixed === "no" && !comment) {
        throw new ValidationError("Say what is still wrong.", {
          comment: ["Say what is still wrong."],
        });
      }
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "answer", before);
        requireNotArchived(key, before);
        if (before.ready_at === null) {
          throw new HttpError(409, "not_waiting", `Ticket ${key} is not waiting for an answer.`);
        }
        // The answer must be to the question the customer was shown, not an older one.
        if (before.ready_token !== ready_token) {
          throw new HttpError(
            409,
            "question_changed",
            `The question on ticket ${key} has changed. Reload the ticket and answer again.`,
          );
        }
        const now = new Date().toISOString();
        const status = fixed === "yes" ? "resolved" : "in_progress";
        repository.updateTicketStatus(db, before.id, status, now);
        if (fixed === "no") {
          repository.insertEntry(db, {
            ticket_id: before.id,
            kind: "reply",
            body: comment!,
            author: actor.id,
            author_kind: actor.kind,
            author_role: actor.role,
            author_name: actor.name,
            created_at: now,
          });
        }
        logEvent({
          ticketId: before.id,
          actor: actor.id,
          actorKind: actor.kind,
          type: "customer_answered",
          data: { fixed: fixed === "yes" },
          now,
        });
        return { ...before, status, ...noQuestion, updated_at: now } as repository.TicketRow;
      })();
      return toTicket(row);
    },

    /** Makes the actor the owner of the ticket, also when someone else owned it before. */
    takeTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "take", before);
        requireNotArchived(key, before);
        if (before.owner_id === actor.id) return before; // already theirs
        return setOwner(before, actor.id, actor.name, actor);
      })();
      return toTicket(row);
    },

    /** Leaves the ticket without an owner. Not while it is in progress. */
    releaseTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "release", before);
        requireNotArchived(key, before);
        if (before.owner_id === null) return before; // nobody owns it
        if (before.status === "in_progress") {
          throw new HttpError(
            409,
            "needs_owner",
            `Ticket ${key} is in progress, so it must keep an owner. Someone else can take it.`,
          );
        }
        return setOwner(before, null, null, actor);
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
        logEvent({
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
        logEvent({
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
      const events = repository.listEvents(db, row.id, THREAD_LIMIT).map(toEvent);
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
        requireRoom(
          repository.countRows(db, "ticket_entries", ticket.id),
          budget.entriesPerTicket,
          "replies on this ticket",
        );
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
        logEvent({
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
      return repository.listEntries(db, row.id, includeNotes, THREAD_LIMIT).map(toEntry);
    },

    /**
     * Deletes the ticket and everything that belongs to it, for good. Only its number, the
     * time and who did it are kept. The input must repeat the ticket's key, so that it
     * cannot happen by a slip.
     */
    deleteTicket(key: string, input: unknown, actor: Actor): { filesCleaned: boolean } {
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
      // The ticket is gone from the database now. Whether its old text has also left the
      // files on disk depends on the checkpoint, which reports it.
      return { filesCleaned: repository.flushDeletedContent(db) };
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
        take: !archived && can(actor, "take", ticket) && ticket.owner_id !== actor.id,
        release:
          !archived &&
          can(actor, "release", ticket) &&
          ticket.owner_id !== null &&
          ticket.status !== "in_progress",
        agreeCheck: !archived && can(actor, "agree_check", ticket),
        linkChange: !archived && can(actor, "link_change", ticket),
        markReady:
          !archived &&
          can(actor, "mark_ready", ticket) &&
          ticket.status === "in_progress" &&
          ticket.change_url !== null &&
          ticket.ready_at === null,
        answer: !archived && can(actor, "answer", ticket) && ticket.ready_at !== null,
        reply: !archived && can(actor, "reply", ticket),
        note: !archived && can(actor, "note", ticket),
      };
    },
  };
}

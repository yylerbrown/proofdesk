import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { buildKey, parseKey } from "./keys.js";
import * as repository from "./repository.js";
import type { CreateTicketInput, TicketStatus } from "./schemas.js";

// The rules for tickets live here: key handling, "not found", "same status is a no-op",
// and which writes must happen together in one transaction. Routes and pages call these
// functions and nothing else.

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
};

export type TicketEvent = {
  id: number;
  ticket_key: string;
  actor: string;
  type: string;
  data: unknown;
  created_at: string;
};

export type TicketService = ReturnType<typeof createTicketService>;

export function createTicketService(db: Db, prefix: string) {
  function toTicket(row: repository.TicketRow): Ticket {
    const { id, ...rest } = row;
    return { key: buildKey(prefix, id), ...rest };
  }

  function toEvent(row: repository.EventRow): TicketEvent {
    return {
      id: row.id,
      ticket_key: buildKey(prefix, row.ticket_id),
      actor: row.actor,
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

  return {
    createTicket(input: CreateTicketInput, actor: Actor): Ticket {
      const now = new Date().toISOString();
      const id = db.transaction(() => {
        const newId = repository.insertTicket(db, {
          title: input.title,
          description: input.description,
          whereUrl: input.where_url ?? null,
          fixCheck: input.fix_check || null,
          now,
        });
        repository.insertEvent(db, {
          ticketId: newId,
          actor: actor.id,
          type: "created",
          data: { status: "new" },
          now,
        });
        return newId;
      })();
      return toTicket(repository.findTicket(db, id)!);
    },

    listTickets(status: TicketStatus | "all"): Ticket[] {
      const filter = status === "all" ? undefined : status;
      return repository.listTickets(db, filter).map(toTicket);
    },

    getTicket(key: string): Ticket {
      return toTicket(requireRow(key));
    },

    changeStatus(key: string, newStatus: TicketStatus, actor: Actor): Ticket {
      db.transaction(() => {
        const row = requireRow(key);
        if (row.status === newStatus) return; // nothing changes, so nothing is logged
        const now = new Date().toISOString();
        repository.updateTicketStatus(db, row.id, newStatus, now);
        repository.insertEvent(db, {
          ticketId: row.id,
          actor: actor.id,
          type: "status_changed",
          data: { from: row.status, to: newStatus },
          now,
        });
      })();
      return toTicket(requireRow(key));
    },

    listEvents(key: string): TicketEvent[] {
      const row = requireRow(key);
      return repository.listEvents(db, row.id).map(toEvent);
    },
  };
}

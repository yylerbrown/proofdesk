import type { Db } from "../db.js";
import type { TicketStatus } from "./schemas.js";

// All SQL for tickets lives in this file. Every statement is a fixed string with ?
// placeholders, so no user input is ever joined into SQL text.

export type TicketRow = {
  id: number;
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

export type EventRow = {
  id: number;
  ticket_id: number;
  actor: string;
  actor_kind: ActorKind;
  type: string;
  data: string; // JSON text
  created_at: string;
};

export type ActorKind = "person" | "agent";

export type NewTicket = {
  title: string;
  description: string;
  whereUrl: string | null;
  fixCheck: string | null;
  now: string;
};

export type NewEvent = {
  ticketId: number;
  actor: string;
  actorKind: ActorKind;
  type: string;
  data: object;
  now: string;
};

/** Inserts a ticket with status "new" and returns its number. */
export function insertTicket(db: Db, ticket: NewTicket): number {
  const result = db
    .prepare(
      `INSERT INTO tickets (title, description, where_url, fix_check, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticket.title,
      ticket.description,
      ticket.whereUrl,
      ticket.fixCheck,
      ticket.now,
      ticket.now,
    );
  return Number(result.lastInsertRowid);
}

export function findTicket(db: Db, id: number): TicketRow | undefined {
  return db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;
}

/** Tickets that are not archived, newest first. Pass undefined to get every status. */
export function listTickets(db: Db, status: TicketStatus | undefined): TicketRow[] {
  if (status === undefined) {
    return db
      .prepare("SELECT * FROM tickets WHERE archived_at IS NULL ORDER BY id DESC")
      .all() as TicketRow[];
  }
  return db
    .prepare("SELECT * FROM tickets WHERE archived_at IS NULL AND status = ? ORDER BY id DESC")
    .all(status) as TicketRow[];
}

/** Archived tickets only, newest first. */
export function listArchivedTickets(db: Db): TicketRow[] {
  return db
    .prepare("SELECT * FROM tickets WHERE archived_at IS NOT NULL ORDER BY id DESC")
    .all() as TicketRow[];
}

export type TicketText = {
  title: string;
  description: string;
  whereUrl: string | null;
  fixCheck: string | null;
};

export function updateTicketText(db: Db, id: number, text: TicketText, now: string): void {
  db.prepare(
    `UPDATE tickets SET title = ?, description = ?, where_url = ?, fix_check = ?, updated_at = ?
     WHERE id = ?`,
  ).run(text.title, text.description, text.whereUrl, text.fixCheck, now, id);
}

/** Pass a time to archive the ticket, or null to restore it. */
export function updateTicketArchived(
  db: Db,
  id: number,
  archivedAt: string | null,
  now: string,
): void {
  db.prepare("UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ?").run(
    archivedAt,
    now,
    id,
  );
}

export function updateTicketStatus(db: Db, id: number, status: TicketStatus, now: string): void {
  db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
}

export function insertEvent(db: Db, event: NewEvent): void {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, actor, actor_kind, type, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    event.ticketId,
    event.actor,
    event.actorKind,
    event.type,
    JSON.stringify(event.data),
    event.now,
  );
}

/** Oldest first. */
export function listEvents(db: Db, ticketId: number): EventRow[] {
  return db
    .prepare("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC")
    .all(ticketId) as EventRow[];
}

/** Reads one value from the app_meta table, or undefined when the key is not there. */
export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function insertMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run(key, value);
}

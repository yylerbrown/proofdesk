import type { Db } from "../db.js";
import type { EntryKind, TicketStatus } from "./schemas.js";

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
  owner_name: string | null;
  agreed_check: string | null;
  change_url: string | null;
  try_url: string | null;
  ready_at: string | null;
  ready_token: string | null;
};

export type EventRow = {
  id: number;
  ticket_id: number;
  actor: string;
  actor_kind: ActorKind;
  type: string;
  data: string; // JSON text
  created_at: string;
  actor_context: string | null; // JSON text, for an agent's action
};

export type ActorKind = "person" | "agent";

export type NewTicket = {
  title: string;
  description: string;
  whereUrl: string | null;
  fixCheck: string | null;
  createdBy: string;
  now: string;
};

export type NewEvent = {
  ticketId: number;
  actor: string;
  actorKind: ActorKind;
  type: string;
  data: object;
  now: string;
  /** For an agent's action: its connection, issuer, scopes and the ticket's owner. */
  context?: object | null;
};

/** Inserts a ticket with status "new" and returns its number. */
export function insertTicket(db: Db, ticket: NewTicket): number {
  const result = db
    .prepare(
      `INSERT INTO tickets
         (title, description, where_url, fix_check, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ticket.title,
      ticket.description,
      ticket.whereUrl,
      ticket.fixCheck,
      ticket.createdBy,
      ticket.now,
      ticket.now,
    );
  return Number(result.lastInsertRowid);
}

export function findTicket(db: Db, id: number): TicketRow | undefined {
  return db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as TicketRow | undefined;
}

/** Which slice of a long list to read: at most `limit` rows, after skipping `offset`. */
export type Page = { limit: number; offset: number };

/**
 * Every ticket that is not archived: open ones first, newest first, then resolved ones.
 * Pass a status to get only that status.
 */
export function listAllTickets(db: Db, status: TicketStatus | null, page: Page): TicketRow[] {
  return db
    .prepare(
      `SELECT * FROM tickets
       WHERE archived_at IS NULL AND (@status IS NULL OR status = @status)
       ORDER BY status = 'resolved', id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ status, ...page }) as TicketRow[];
}

/**
 * The tickets one person filed that are not archived, in the same order as above. There is no way to ask
 * it for everyone's tickets, so a mistake in a caller cannot show a customer other people's
 * tickets. created_by is a plain condition, so the index on it is used.
 */
export function listTicketsFiledBy(
  db: Db,
  createdBy: string,
  status: TicketStatus | null,
  page: Page,
): TicketRow[] {
  return db
    .prepare(
      `SELECT * FROM tickets
       WHERE created_by = @createdBy AND archived_at IS NULL
         AND (@status IS NULL OR status = @status)
       ORDER BY status = 'resolved', id DESC LIMIT @limit OFFSET @offset`,
    )
    .all({ createdBy, status, ...page }) as TicketRow[];
}

/** Archived tickets only, newest first. */
export function listArchivedTickets(db: Db, page: Page): TicketRow[] {
  return db
    .prepare(
      `SELECT * FROM tickets WHERE archived_at IS NOT NULL
       ORDER BY id DESC LIMIT @limit OFFSET @offset`,
    )
    .all(page) as TicketRow[];
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

export function updateAgreedCheck(db: Db, id: number, agreed: string | null, now: string): void {
  db.prepare("UPDATE tickets SET agreed_check = ?, updated_at = ? WHERE id = ?").run(
    agreed,
    now,
    id,
  );
}

/** Sets the owner of a ticket. Pass null for both to leave it without an owner. */
export function updateTicketOwner(
  db: Db,
  id: number,
  ownerId: string | null,
  ownerName: string | null,
  now: string,
): void {
  db.prepare("UPDATE tickets SET owner_id = ?, owner_name = ?, updated_at = ? WHERE id = ?").run(
    ownerId,
    ownerName,
    now,
    id,
  );
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

/**
 * Changes the status. Any change of status also ends a wait for the customer's answer: the
 * question "Did this fix it?" is only asked about the ticket as it was when it was asked.
 */
export function updateTicketStatus(db: Db, id: number, status: TicketStatus, now: string): void {
  db.prepare(
    "UPDATE tickets SET status = ?, ready_at = NULL, ready_token = NULL, updated_at = ? WHERE id = ?",
  ).run(status, now, id);
}

export function updateChangeUrl(db: Db, id: number, changeUrl: string, now: string): void {
  db.prepare("UPDATE tickets SET change_url = ?, updated_at = ? WHERE id = ?").run(
    changeUrl,
    now,
    id,
  );
}

/** Starts the wait for the customer's answer, with the page to try and a fresh token. */
export function updateReady(db: Db, id: number, tryUrl: string, token: string, now: string): void {
  db.prepare(
    "UPDATE tickets SET try_url = ?, ready_at = ?, ready_token = ?, updated_at = ? WHERE id = ?",
  ).run(tryUrl, now, token, now, id);
}

/** Withdraws the question "Did this fix it?", because what it was about has changed. */
export function clearReady(db: Db, id: number): void {
  db.prepare("UPDATE tickets SET ready_at = NULL, ready_token = NULL WHERE id = ?").run(id);
}

export function insertEvent(db: Db, event: NewEvent): void {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, actor, actor_kind, type, data, created_at, actor_context)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.ticketId,
    event.actor,
    event.actorKind,
    event.type,
    JSON.stringify(event.data),
    event.now,
    event.context ? JSON.stringify(event.context) : null,
  );
}

export type IdempotencyRow = {
  actor: string;
  key: string;
  action: string;
  request_hash: string;
  response: string;
  ticket_id: number | null;
  created_at: string;
};

export function findIdempotency(db: Db, actor: string, key: string): IdempotencyRow | undefined {
  return db
    .prepare("SELECT * FROM idempotency_keys WHERE actor = ? AND key = ?")
    .get(actor, key) as IdempotencyRow | undefined;
}

/** Remembers a write's answer, and forgets answers older than a day. */
export function saveIdempotency(db: Db, row: IdempotencyRow): void {
  const dayAgo = new Date(Date.parse(row.created_at) - 24 * 3600 * 1000).toISOString();
  db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(dayAgo);
  db.prepare(
    `INSERT INTO idempotency_keys (actor, key, action, request_hash, response, ticket_id, created_at)
     VALUES (@actor, @key, @action, @request_hash, @response, @ticket_id, @created_at)`,
  ).run(row);
}

/** The named human owner of a ticket right now, or null. */
export function ownerOf(db: Db, ticketId: number): string | null {
  const row = db.prepare("SELECT owner_id FROM tickets WHERE id = ?").get(ticketId) as
    { owner_id: string | null } | undefined;
  return row?.owner_id ?? null;
}

/** The latest `limit` events of a ticket, oldest first. */
export function listEvents(db: Db, ticketId: number, limit: number): EventRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(ticketId, limit) as EventRow[];
}

/** How many rows a ticket has in a table that has a ticket_id column. */
export function countRows(
  db: Db,
  table: "ticket_events" | "ticket_entries" | "ticket_evidence",
  id: number,
): number {
  // The table name is one of the fixed names above, never from a request.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ticket_id = ?`).get(id);
  return (row as { n: number }).n;
}

export function countTickets(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;
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

/**
 * Every table other than tickets whose rows belong to one ticket, through a ticket_id
 * column. Permanent deletion removes their rows. A test fails if a table with a ticket_id
 * column is missing here, so a new table cannot be forgotten.
 */
export const TICKET_TABLES = [
  "ticket_events",
  "ticket_entries",
  "ticket_evidence",
  "idempotency_keys",
];

/**
 * Removes a ticket and every row that belongs to it, and records that it was deleted.
 * Call it inside a transaction. The marker goes in first, because the event log only lets
 * the events of a listed ticket be removed.
 */
export function deleteTicketForever(db: Db, id: number, deletedBy: string, now: string): void {
  db.prepare(
    "INSERT INTO deleted_tickets (ticket_id, deleted_at, deleted_by) VALUES (?, ?, ?)",
  ).run(id, now, deletedBy);
  for (const table of TICKET_TABLES) {
    // The table name comes from the fixed list above, never from a request.
    db.prepare(`DELETE FROM ${table} WHERE ticket_id = ?`).run(id);
  }
  db.prepare("DELETE FROM tickets WHERE id = ?").run(id);
}

/** True when a ticket with this number was deleted permanently. */
export function wasDeleted(db: Db, id: number): boolean {
  return db.prepare("SELECT 1 FROM deleted_tickets WHERE ticket_id = ?").get(id) !== undefined;
}

/**
 * Tries to make deleted content leave the files on disk now, and says whether it did.
 * Changes first go to a log file next to the database (the "-wal" file), and the old text
 * stays there until a checkpoint. TRUNCATE copies the log into the main file, where
 * secure_delete has zeroed the deleted rows, and empties the log. It cannot finish while
 * another connection is in the middle of reading; SQLite then reports busy.
 */
export function flushDeletedContent(db: Db): boolean {
  // Try once without waiting. By default SQLite would wait up to five seconds for the
  // reader, and this server does everything on one thread, so every request would wait.
  const waitMs = db.pragma("busy_timeout", { simple: true }) as number;
  db.pragma("busy_timeout = 0");
  try {
    const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
    return result !== undefined && result.busy === 0;
  } finally {
    db.pragma(`busy_timeout = ${waitMs}`);
  }
}

export type EntryRow = {
  id: number;
  ticket_id: number;
  kind: EntryKind;
  body: string;
  author: string;
  author_kind: ActorKind;
  author_role: "customer" | "team" | "admin";
  author_name: string;
  created_at: string;
};

export type NewEntry = Omit<EntryRow, "id">;

export type EvidenceRow = {
  id: number;
  ticket_id: number;
  kind: string;
  summary: string;
  link: string | null;
  revision: string | null;
  command: string | null;
  result: string | null;
  report: string | null; // JSON text, as sent
  author: string;
  author_kind: ActorKind;
  author_name: string;
  connection_id: number | null;
  created_at: string;
};

export type NewEvidence = Omit<EvidenceRow, "id">;

export function insertEvidence(db: Db, evidence: NewEvidence): EvidenceRow {
  const result = db
    .prepare(
      `INSERT INTO ticket_evidence
         (ticket_id, kind, summary, link, revision, command, result, report,
          author, author_kind, author_name, connection_id, created_at)
       VALUES (@ticket_id, @kind, @summary, @link, @revision, @command, @result, @report,
          @author, @author_kind, @author_name, @connection_id, @created_at)`,
    )
    .run(evidence);
  return { id: Number(result.lastInsertRowid), ...evidence };
}

/** The latest `limit` pieces of evidence on a ticket, oldest first. */
export function listEvidence(db: Db, ticketId: number, limit: number): EvidenceRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM ticket_evidence WHERE ticket_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id ASC`,
    )
    .all(ticketId, limit) as EvidenceRow[];
}

/** Inserts an entry and returns it with its number. */
export function insertEntry(db: Db, entry: NewEntry): EntryRow {
  const result = db
    .prepare(
      `INSERT INTO ticket_entries
       (ticket_id, kind, body, author, author_kind, author_role, author_name, created_at)
     VALUES (@ticket_id, @kind, @body, @author, @author_kind, @author_role, @author_name, @created_at)`,
    )
    .run(entry);
  return { id: Number(result.lastInsertRowid), ...entry };
}

/** The latest `limit` entries, oldest first. Notes are left out unless includeNotes is true. */
export function listEntries(
  db: Db,
  ticketId: number,
  includeNotes: boolean,
  limit: number,
): EntryRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM ticket_entries
         WHERE ticket_id = @ticketId AND (@includeNotes = 1 OR kind = 'reply')
         ORDER BY id DESC LIMIT @limit
       ) ORDER BY id ASC`,
    )
    .all({ ticketId, includeNotes: includeNotes ? 1 : 0, limit }) as EntryRow[];
}

/** The names of the people who signed in with GitHub, for the ids given that have one. */
export function userNames(db: Db, ids: string[]): Map<string, string> {
  const names = new Map<string, string>();
  const find = db.prepare('SELECT name FROM "user" WHERE id = ?');
  for (const id of new Set(ids)) {
    const row = find.get(id) as { name: string } | undefined;
    if (row !== undefined) names.set(id, row.name);
  }
  return names;
}

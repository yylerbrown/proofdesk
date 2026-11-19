import type { Db } from "../db.js";
import type {
  EntryKind,
  ListSort,
  ListSortColumn,
  ResolveReason,
  TicketStatus,
} from "./schemas.js";

// The SQL for tickets lives in this file. Every statement here is a fixed string with ?
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
  ready_tried: string | null;
  ready_result: string | null;
  ready_response: string | null;
  ready_evidence: string | null; // JSON list of evidence ids
  // Set only when the team resolved the ticket without the customer's Yes.
  resolved_reason: ResolveReason | null;
  resolved_note: string | null;
  resolved_duplicate_of: string | null;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | null;
  // When the ticket last moved to Resolved, whoever resolved it; null while it is open.
  last_resolved_at: string | null;
  // Rises by one on every change to the row, by a trigger in the database.
  version: number;
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

/** The ticket's version as it is saved now, or undefined when there is no such ticket. */
export function versionOf(db: Db, id: number): number | undefined {
  const row = db.prepare("SELECT version FROM tickets WHERE id = ?").get(id) as
    { version: number } | undefined;
  return row?.version;
}

/** How many replies, and internal notes when asked for, the ticket has. */
export function countEntries(db: Db, ticketId: number, includeNotes: boolean): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM ticket_entries WHERE ticket_id = ? AND (? = 1 OR kind = 'reply')",
    )
    .get(ticketId, includeNotes ? 1 : 0) as { n: number };
  return row.n;
}

/** How many times the ticket was handed to an assistant, plus how many of those ended. */
export function countHandoffChanges(db: Db, ticketId: number): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) + COUNT(ended_at) AS n FROM ticket_agent_handoffs WHERE ticket_id = ?",
    )
    .get(ticketId) as { n: number };
  return row.n;
}

/** Which slice of a long list to read: at most `limit` rows, after skipping `offset`. */
export type Page = { limit: number; offset: number };

/**
 * How a list may be narrowed: to one owner or to tickets nobody owns, and to tickets whose title
 * or description holds the search. A ticket is found when its text holds `search`, a LIKE pattern
 * the service escapes, or when its words match `match`, a query for the ticket_search word index
 * the service builds from quoted words. With `resolvedSince`, a resolved ticket is kept only when
 * it moved to Resolved at that time or later; open tickets are always kept.
 */
export type Narrowing = {
  ownerId: string | null;
  unassigned: boolean;
  search: string | null;
  match: string | null;
  resolvedSince: string | null;
};
export const NO_NARROWING: Narrowing = {
  ownerId: null,
  unassigned: false,
  search: null,
  match: null,
  resolvedSince: null,
};

/**
 * Whose tickets a list holds. The service decides this from who is asking, once, and the same
 * scope then gives both the rows and the counts, so the two can never disagree.
 * - everyone: every ticket that is not archived, for the team.
 * - among: the tickets among these ids that are not archived, for an assistant. The ids are
 *   applied before the page is cut, so a page holds as many of them as fit.
 * - among_or_wanting_check: the same, and also every New ticket with no check, for an
 *   assistant an admin allowed to suggest ways to verify them.
 * - filed_by: the tickets one person filed that are not archived, for a customer. There is no
 *   way to ask it for everyone's tickets, so a mistake in a caller cannot show a customer other
 *   people's tickets.
 * - archived: archived tickets only.
 */
export type ListScope =
  | { kind: "everyone" }
  | { kind: "among"; ids: number[] }
  | { kind: "among_or_wanting_check"; ids: number[] }
  | { kind: "filed_by"; createdBy: string }
  | { kind: "archived" };

// Each scope's condition. Fixed strings: the values are bound.
const SCOPE_SQL: Record<ListScope["kind"], string> = {
  everyone: "archived_at IS NULL",
  among: "archived_at IS NULL AND id IN (SELECT value FROM json_each(@ids))",
  among_or_wanting_check: `archived_at IS NULL AND (id IN (SELECT value FROM json_each(@ids))
    OR (status = 'new' AND fix_check IS NULL))`,
  filed_by: "archived_at IS NULL AND created_by = @createdBy",
  archived: "archived_at IS NOT NULL",
};

// The same narrowing in every list and count. A fixed string: the values are bound.
const NARROWED = `AND (@ownerId IS NULL OR owner_id = @ownerId)
       AND (@unassigned = 0 OR owner_id IS NULL)
       AND (@search IS NULL OR title LIKE @search ESCAPE '\\' OR description LIKE @search ESCAPE '\\'
         OR (@match IS NOT NULL
             AND id IN (SELECT rowid FROM ticket_search WHERE ticket_search MATCH @match)))
       AND (@resolvedSince IS NULL OR status <> 'resolved' OR last_resolved_at >= @resolvedSince)`;

// Each column's sort as SQL terms, each ending on the id, so the order is total and a page never
// repeats or skips a ticket that did not change. Descending runs every term the other way, so it
// is the exact reverse. Migrations 0032 and 0034 have an index for each, read forwards or
// backwards, so the team's list never sorts the whole table.
const SORT_TERMS: Record<ListSortColumn, string[]> = {
  key: ["id"],
  title: ["title COLLATE NOCASE", "id"],
  // The workflow's order: New, then In Progress, then Resolved.
  status: ["(CASE status WHEN 'new' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END)", "id"],
  // Owners A to Z, then the tickets nobody owns.
  owner: ["(owner_name IS NULL)", "owner_name COLLATE NOCASE", "id"],
  filed: ["created_at", "id"],
  updated: ["updated_at", "id"],
};

/** The ORDER BY for a sort, built only from the fixed terms above. */
function orderBy(sort: ListSort): string {
  // The default: open tickets first, newest first, then resolved ones, newest first.
  if (sort === "open_first") return "status = 'resolved', id DESC";
  const way = sort.direction === "asc" ? "ASC" : "DESC";
  return SORT_TERMS[sort.by].map((term) => `${term} ${way}`).join(", ");
}

/** The values the statements above bind, with only the ones this scope names. */
function bound(scope: ListScope, narrow: Narrowing) {
  return {
    ownerId: narrow.ownerId,
    unassigned: narrow.unassigned ? 1 : 0,
    search: narrow.search,
    match: narrow.match,
    resolvedSince: narrow.resolvedSince,
    ...scopeValues(scope),
  };
}

/** The values one scope's condition binds. */
function scopeValues(scope: ListScope): Record<string, unknown> {
  if (scope.kind === "among" || scope.kind === "among_or_wanting_check") {
    return { ids: JSON.stringify(scope.ids) };
  }
  if (scope.kind === "filed_by") return { createdBy: scope.createdBy };
  return {};
}

/** One page of the tickets in this scope, of one status or of every status, sorted this way. */
export function listTickets(
  db: Db,
  scope: ListScope,
  status: TicketStatus | null,
  sort: ListSort,
  page: Page,
  narrow: Narrowing = NO_NARROWING,
): TicketRow[] {
  return db
    .prepare(
      `SELECT * FROM tickets
       WHERE ${SCOPE_SQL[scope.kind]} AND (@status IS NULL OR status = @status)
       ${NARROWED}
       ORDER BY ${orderBy(sort)} LIMIT @limit OFFSET @offset`,
    )
    .all({ ...bound(scope, narrow), status, ...page }) as TicketRow[];
}

/**
 * How many tickets of each status the same scope and narrowing hold, in one grouped query.
 * A status with no tickets counts 0.
 */
export function countTicketsByStatus(
  db: Db,
  scope: ListScope,
  narrow: Narrowing = NO_NARROWING,
): Record<TicketStatus, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM tickets
       WHERE ${SCOPE_SQL[scope.kind]}
       ${NARROWED}
       GROUP BY status`,
    )
    .all(bound(scope, narrow)) as { status: TicketStatus; n: number }[];
  const counts: Record<TicketStatus, number> = { new: 0, in_progress: 0, resolved: 0 };
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

/**
 * How many resolved tickets in this scope and narrowing moved to Resolved before this time: the
 * ones a list cut at that time leaves out. A resolved ticket with no time counts as older.
 */
export function countResolvedBefore(
  db: Db,
  scope: ListScope,
  narrow: Narrowing,
  before: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets
       WHERE ${SCOPE_SQL[scope.kind]} AND status = 'resolved'
       AND (last_resolved_at IS NULL OR last_resolved_at < @before)
       ${NARROWED}`,
    )
    .get({ ...bound(scope, narrow), before }) as { n: number };
  return row.n;
}

/** A ticket a similar title names: its id, its title and its status. */
export type SimilarRow = { id: number; title: string; status: TicketStatus };

/**
 * The one ticket in this scope whose title holds at least `need` of these words, in any form:
 * the one holding the most, then an open one before a resolved one, then the newest. Each word
 * is looked for in the title only, inside double quotes, so it is never read as query syntax.
 * The words hold only letters and digits. Only the count of matched words decides, never a
 * score from the index, so the answer depends on the tickets in this scope alone.
 */
export function similarTitle(
  db: Db,
  scope: ListScope,
  words: string[],
  need: number,
): SimilarRow | undefined {
  return db
    .prepare(
      `WITH seen AS (SELECT id, title, status FROM tickets WHERE ${SCOPE_SQL[scope.kind]})
       SELECT seen.id AS id, seen.title AS title, seen.status AS status
       FROM json_each(@words) AS word
       JOIN ticket_search ON ticket_search MATCH ('{title} : "' || word.value || '"')
       JOIN seen ON seen.id = ticket_search.rowid
       GROUP BY seen.id
       HAVING COUNT(*) >= @need
       ORDER BY COUNT(*) DESC, seen.status = 'resolved', seen.id DESC
       LIMIT 1`,
    )
    .get({ ...scopeValues(scope), words: JSON.stringify(words), need }) as SimilarRow | undefined;
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
/**
 * Changes the status. Any change clears a resolution by the team: only the team's own sets one.
 * Moving to Resolved from another status records when; staying Resolved keeps the earlier time,
 * and any other status clears it.
 */
export function updateTicketStatus(db: Db, id: number, status: TicketStatus, now: string): void {
  db.prepare(
    `UPDATE tickets SET status = @status, ready_at = NULL, ready_token = NULL, updated_at = @now,
       resolved_reason = NULL, resolved_note = NULL, resolved_duplicate_of = NULL,
       resolved_by = NULL, resolved_by_name = NULL, resolved_at = NULL,
       last_resolved_at = CASE
         WHEN @status <> 'resolved' THEN NULL
         WHEN status = 'resolved' THEN last_resolved_at
         ELSE @now
       END
     WHERE id = @id`,
  ).run({ status, now, id });
}

export type TeamResolution = {
  reason: ResolveReason;
  note: string | null;
  duplicateOf: string | null;
  by: string;
  byName: string;
};

/** Resolves the ticket by the team, with its reason, and closes any open question. */
export function resolveByTeam(db: Db, id: number, r: TeamResolution, now: string): void {
  db.prepare(
    `UPDATE tickets SET status = 'resolved', ready_at = NULL, ready_token = NULL, updated_at = @now,
       resolved_reason = @reason, resolved_note = @note, resolved_duplicate_of = @duplicateOf,
       resolved_by = @by, resolved_by_name = @byName, resolved_at = @now,
       last_resolved_at = CASE WHEN status = 'resolved' THEN last_resolved_at ELSE @now END
     WHERE id = @id`,
  ).run({ ...r, now, id });
}

export function updateChangeUrl(db: Db, id: number, changeUrl: string, now: string): void {
  db.prepare("UPDATE tickets SET change_url = ?, updated_at = ? WHERE id = ?").run(
    changeUrl,
    now,
    id,
  );
}

/** What the owner records when asking the customer. */
export type AskRecord = {
  tryUrl: string | null;
  tried: string | null;
  result: string | null;
  response: string | null;
  evidenceIds: number[];
};

/** Starts the wait for the customer's answer, with the page to try and a fresh token. */
export function updateReady(db: Db, id: number, ask: AskRecord, token: string, now: string): void {
  db.prepare(
    `UPDATE tickets SET try_url = ?, ready_tried = ?, ready_result = ?, ready_response = ?,
       ready_evidence = ?, ready_at = ?, ready_token = ?, updated_at = ? WHERE id = ?`,
  ).run(
    ask.tryUrl,
    ask.tried,
    ask.result,
    ask.response,
    JSON.stringify(ask.evidenceIds),
    now,
    token,
    now,
    id,
  );
}

/** Withdraws the question "Did this fix it?", because what it was about has changed. */
export function clearReady(db: Db, id: number, now: string): void {
  db.prepare(
    "UPDATE tickets SET ready_at = NULL, ready_token = NULL, updated_at = ? WHERE id = ?",
  ).run(now, id);
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

/**
 * The customer's latest answer to "Did this fix it?" on a ticket, with their comment for a no,
 * or undefined if they have never answered. An answer recorded before comments were kept in
 * the history finds its comment in the reply written at the same moment.
 */
export function latestAnswer(
  db: Db,
  ticketId: number,
): { fixed: boolean; at: string; comment: string | null } | undefined {
  const event = db
    .prepare(
      `SELECT actor, data, created_at FROM ticket_events
       WHERE ticket_id = ? AND type = 'customer_answered' ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId) as { actor: string; data: string; created_at: string } | undefined;
  if (event === undefined) return undefined;
  const data = JSON.parse(event.data) as { fixed?: boolean; comment?: string };
  let comment = data.comment ?? null;
  if (data.fixed === false && comment === null) {
    const entry = db
      .prepare(
        `SELECT body FROM ticket_entries
         WHERE ticket_id = ? AND author = ? AND created_at = ? AND kind = 'reply' LIMIT 1`,
      )
      .get(ticketId, event.actor, event.created_at) as { body: string } | undefined;
    comment = entry?.body ?? null;
  }
  return { fixed: data.fixed === true, at: event.created_at, comment };
}

/**
 * The ids of the evidence the owner chose to show the customer in any question asked on a
 * ticket, the open one included.
 */
export function evidenceChosenForCustomer(db: Db, ticketId: number): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT chosen.value AS id FROM ticket_events e, json_each(e.data, '$.evidence_ids') chosen
       WHERE e.ticket_id = ? AND e.type = 'ready_for_customer'`,
    )
    .all(ticketId) as { id: number }[];
  return new Set(rows.map((row) => row.id));
}

/**
 * Of these tickets, the ids of those whose customer's latest word is their reopening it: a
 * reopening newer than any answer to "Did this fix it?".
 */
export function reopenedByCustomer(db: Db, ticketIds: number[]): number[] {
  const rows = db
    .prepare(
      `SELECT e.ticket_id FROM ticket_events e
       WHERE e.ticket_id IN (SELECT value FROM json_each(@ids))
         AND e.type = 'reopened'
         AND e.id = (SELECT MAX(x.id) FROM ticket_events x
                     WHERE x.ticket_id = e.ticket_id
                       AND x.type IN ('customer_answered', 'reopened'))`,
    )
    .all({ ids: JSON.stringify(ticketIds) }) as { ticket_id: number }[];
  return rows.map((row) => row.ticket_id);
}

/** The agent connection a ticket is handed to right now, or undefined. */
export function activeHandoff(
  db: Db,
  ticketId: number,
): { connection_id: number; name: string; granted_at: string } | undefined {
  return db
    .prepare(
      `SELECT h.connection_id, c.name, h.granted_at FROM ticket_agent_handoffs h
       JOIN agent_connections c ON c.id = h.connection_id
       WHERE h.ticket_id = ? AND h.ended_at IS NULL LIMIT 1`,
    )
    .get(ticketId) as { connection_id: number; name: string; granted_at: string } | undefined;
}

/** The ids of the tickets handed to a connection right now. */
export function handedTicketIds(db: Db, connectionId: number): number[] {
  return (
    db
      .prepare(
        "SELECT ticket_id FROM ticket_agent_handoffs WHERE connection_id = ? AND ended_at IS NULL",
      )
      .all(connectionId) as { ticket_id: number }[]
  ).map((row) => row.ticket_id);
}

/** The ids of the tickets still handed to a connection that has been revoked. */
export function ticketsHandedToEndedConnections(db: Db): number[] {
  return (
    db
      .prepare(
        `SELECT h.ticket_id FROM ticket_agent_handoffs h
         JOIN agent_connections c ON c.id = h.connection_id
         WHERE h.ended_at IS NULL AND c.revoked_at IS NOT NULL`,
      )
      .all() as { ticket_id: number }[]
  ).map((row) => row.ticket_id);
}

export function startHandoff(
  db: Db,
  ticketId: number,
  connectionId: number,
  by: string,
  now: string,
): void {
  db.prepare(
    "INSERT INTO ticket_agent_handoffs (ticket_id, connection_id, granted_by, granted_at) VALUES (?, ?, ?, ?)",
  ).run(ticketId, connectionId, by, now);
}

/** Ends the ticket's current hand-off, if any. Returns the connection's name, or undefined. */
export function endHandoff(
  db: Db,
  ticketId: number,
  reason: string,
  now: string,
): string | undefined {
  const active = activeHandoff(db, ticketId);
  if (active === undefined) return undefined;
  db.prepare(
    "UPDATE ticket_agent_handoffs SET ended_at = ?, end_reason = ? WHERE ticket_id = ? AND ended_at IS NULL",
  ).run(now, reason, ticketId);
  return active.name;
}

/** The connections an owner may hand a ticket to: issued by a person, not revoked or expired. */
export function liveConnections(db: Db, now: string): { id: number; name: string }[] {
  return db
    .prepare(
      `SELECT id, name FROM agent_connections
       WHERE demo = 0 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY name`,
    )
    .all(now) as { id: number; name: string }[];
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
  "ticket_pictures",
  "ticket_entries",
  "ticket_evidence",
  "idempotency_keys",
  "ticket_specs",
  "ticket_agent_handoffs",
  "email_outbox",
  "check_suggestions",
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
  /** For a reply published from an internal note: that note's id. */
  based_on?: number | null;
  /** 1 when an assistant's note says it is blocked. */
  blocked?: number;
  /** What a note is for: an ordinary note, a suggested reply, or a request for review. */
  purpose?: NotePurpose;
};

export type NotePurpose = "note" | "suggested_reply" | "review_request";

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
  /** The spec and the number of its scenario this evidence says it proves, if any. */
  spec_id: number | null;
  scenario: number | null;
  created_at: string;
};

export type NewEvidence = Omit<EvidenceRow, "id">;

export function insertEvidence(db: Db, evidence: NewEvidence): EvidenceRow {
  const result = db
    .prepare(
      `INSERT INTO ticket_evidence
         (ticket_id, kind, summary, link, revision, command, result, report,
          author, author_kind, author_name, connection_id, spec_id, scenario, created_at)
       VALUES (@ticket_id, @kind, @summary, @link, @revision, @command, @result, @report,
          @author, @author_kind, @author_name, @connection_id, @spec_id, @scenario, @created_at)`,
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
       (ticket_id, kind, body, author, author_kind, author_role, author_name, created_at, based_on, blocked, purpose)
     VALUES (@ticket_id, @kind, @body, @author, @author_kind, @author_role, @author_name, @created_at, @based_on, @blocked, @purpose)`,
    )
    .run({ based_on: null, blocked: 0, purpose: "note", ...entry });
  return {
    id: Number(result.lastInsertRowid),
    based_on: null,
    blocked: 0,
    purpose: "note",
    ...entry,
  };
}

/** For each of these tickets, the latest note an agent wrote on it. */
export function latestAgentNotes(
  db: Db,
  ticketIds: number[],
): {
  ticket_id: number;
  body: string;
  blocked: number;
  purpose: NotePurpose;
  author_name: string;
}[] {
  return db
    .prepare(
      `SELECT e.ticket_id, e.body, e.blocked, e.purpose, e.author_name FROM ticket_entries e
       WHERE e.ticket_id IN (SELECT value FROM json_each(@ids))
         AND e.id = (SELECT MAX(x.id) FROM ticket_entries x
                     WHERE x.ticket_id = e.ticket_id AND x.kind = 'note' AND x.author_kind = 'agent')`,
    )
    .all({ ids: JSON.stringify(ticketIds) }) as {
    ticket_id: number;
    body: string;
    blocked: number;
    purpose: NotePurpose;
    author_name: string;
  }[];
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

export type SpecState = "proposed" | "accepted" | "replaced" | "discarded";

export type SpecRow = {
  id: number;
  ticket_id: number;
  summary: string;
  scenarios: string; // JSON array of scenarios
  state: SpecState;
  author: string;
  author_kind: ActorKind;
  author_name: string;
  connection_id: number | null;
  created_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
};

export type NewSpec = Omit<
  SpecRow,
  "id" | "state" | "decided_by" | "decided_by_name" | "decided_at"
>;

/** The spec in force on a ticket, proposed or accepted, if any. */
export function findActiveSpec(db: Db, ticketId: number): SpecRow | undefined {
  return db
    .prepare("SELECT * FROM ticket_specs WHERE ticket_id = ? AND state IN ('proposed', 'accepted')")
    .get(ticketId) as SpecRow | undefined;
}

/** The latest spec one author proposed on a ticket that was not discarded, if any. */
export function findLatestSpecBy(db: Db, ticketId: number, author: string): SpecRow | undefined {
  return db
    .prepare(
      `SELECT * FROM ticket_specs WHERE ticket_id = ? AND author = ? AND state != 'discarded'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, author) as SpecRow | undefined;
}

/** Inserts a proposed spec, after marking the one in force as replaced. */
export function insertSpec(db: Db, spec: NewSpec): SpecRow {
  db.prepare(
    "UPDATE ticket_specs SET state = 'replaced' WHERE ticket_id = ? AND state IN ('proposed', 'accepted')",
  ).run(spec.ticket_id);
  const result = db
    .prepare(
      `INSERT INTO ticket_specs
         (ticket_id, summary, scenarios, state, author, author_kind, author_name, connection_id,
          created_at)
       VALUES (@ticket_id, @summary, @scenarios, 'proposed', @author, @author_kind, @author_name,
          @connection_id, @created_at)`,
    )
    .run(spec);
  return findSpec(db, Number(result.lastInsertRowid))!;
}

export function findSpec(db: Db, id: number): SpecRow | undefined {
  return db.prepare("SELECT * FROM ticket_specs WHERE id = ?").get(id) as SpecRow | undefined;
}

/** Records a person's decision on a spec: accepted or discarded. */
export function decideSpec(
  db: Db,
  id: number,
  state: "accepted" | "discarded",
  by: { id: string; name: string },
  now: string,
): void {
  db.prepare(
    "UPDATE ticket_specs SET state = ?, decided_by = ?, decided_by_name = ?, decided_at = ? WHERE id = ?",
  ).run(state, by.id, by.name, now, id);
}

export function countSpecs(db: Db, ticketId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ticket_specs WHERE ticket_id = ?")
    .get(ticketId);
  return (row as { n: number }).n;
}

/**
 * The numbers of a spec's scenarios that have evidence naming them. Pass an author to count
 * only their evidence.
 */
export function scenariosWithEvidence(db: Db, specId: number, author: string | null): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT scenario FROM ticket_evidence
       WHERE spec_id = @specId AND scenario IS NOT NULL AND (@author IS NULL OR author = @author)
       ORDER BY scenario`,
    )
    .all({ specId, author }) as { scenario: number }[];
  return rows.map((row) => row.scenario);
}

// One fixed statement per table that demo seeding writes.
const ALL_IDS = {
  tickets: "SELECT id FROM tickets",
  ticket_entries: "SELECT id FROM ticket_entries",
  ticket_events: "SELECT id FROM ticket_events",
} as const;

/** Every id in one of the tables demo seeding writes, to record what it wrote. */
export function allIds(db: Db, table: keyof typeof ALL_IDS): number[] {
  return (db.prepare(ALL_IDS[table]).all() as { id: number }[]).map((row) => row.id);
}

// The ways to verify a ticket that an assistant suggests.

export type SuggestionState = "offered" | "chosen" | "withdrawn";

export type SuggestionRow = {
  id: number;
  ticket_id: number;
  connection_id: number;
  offered_by_name: string;
  words: string;
  state: SuggestionState;
  created_at: string;
};

/** Every suggestion on a ticket, oldest first. */
export function listSuggestions(db: Db, ticketId: number): SuggestionRow[] {
  return db
    .prepare("SELECT * FROM check_suggestions WHERE ticket_id = ? ORDER BY id")
    .all(ticketId) as SuggestionRow[];
}

/** How many suggestions other connections still offer on a ticket. */
export function countOfferedByOthers(db: Db, ticketId: number, connectionId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM check_suggestions
       WHERE ticket_id = ? AND state = 'offered' AND connection_id <> ?`,
    )
    .get(ticketId, connectionId) as { n: number };
  return row.n;
}

/** Removes what one connection still offers on a ticket, before it offers others instead. */
export function deleteOfferedBy(db: Db, ticketId: number, connectionId: number): void {
  db.prepare(
    "DELETE FROM check_suggestions WHERE ticket_id = ? AND connection_id = ? AND state = 'offered'",
  ).run(ticketId, connectionId);
}

export function insertSuggestion(
  db: Db,
  suggestion: {
    ticketId: number;
    connectionId: number;
    offeredByName: string;
    words: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO check_suggestions
       (ticket_id, connection_id, offered_by_name, words, state, created_at)
     VALUES (?, ?, ?, ?, 'offered', ?)`,
  ).run(
    suggestion.ticketId,
    suggestion.connectionId,
    suggestion.offeredByName,
    suggestion.words,
    suggestion.now,
  );
}

export function markChosen(db: Db, id: number): void {
  db.prepare("UPDATE check_suggestions SET state = 'chosen' WHERE id = ?").run(id);
}

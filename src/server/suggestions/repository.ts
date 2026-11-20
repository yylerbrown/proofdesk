import type { Db } from "../db.js";

// The SQL for requests for suggestions. Every statement is a fixed string with ? placeholders.

export type RequestRow = {
  id: number;
  ticket_id: number;
  requested_by: string;
  pressed: 0 | 1;
  created_at: string;
  answered_at: string | null;
  answered_by: number | null;
};

/** A request with what an assistant is shown of its ticket. */
export type RequestWithTicket = RequestRow & { title: string; description: string };

/** Removes the requests made before this time. */
export function removeOlderThan(db: Db, before: string): void {
  db.prepare("DELETE FROM suggestion_requests WHERE created_at < ?").run(before);
}

export function insertRequest(
  db: Db,
  request: { ticketId: number; requestedBy: string; pressed: boolean; now: string },
): number {
  const result = db
    .prepare(
      `INSERT INTO suggestion_requests (ticket_id, requested_by, pressed, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(request.ticketId, request.requestedBy, request.pressed ? 1 : 0, request.now);
  return Number(result.lastInsertRowid);
}

export function findRequest(db: Db, id: number): RequestRow | undefined {
  return db.prepare("SELECT * FROM suggestion_requests WHERE id = ?").get(id) as
    RequestRow | undefined;
}

/** The newest request one person made on one ticket. */
export function latestRequest(
  db: Db,
  ticketId: number,
  requestedBy: string,
): RequestRow | undefined {
  return db
    .prepare(
      `SELECT * FROM suggestion_requests WHERE ticket_id = ? AND requested_by = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, requestedBy) as RequestRow | undefined;
}

/** The request on a ticket still waiting for an answer: unanswered and made since this time. */
export function openRequest(db: Db, ticketId: number, since: string): RequestRow | undefined {
  return db
    .prepare(
      `SELECT * FROM suggestion_requests
       WHERE ticket_id = ? AND answered_at IS NULL AND created_at >= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, since) as RequestRow | undefined;
}

/** How many requests one person made since this time. */
export function countBy(db: Db, requestedBy: string, since: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM suggestion_requests WHERE requested_by = ? AND created_at >= ?",
    )
    .get(requestedBy, since) as { n: number };
  return row.n;
}

export function markPressed(db: Db, id: number): void {
  db.prepare("UPDATE suggestion_requests SET pressed = 1 WHERE id = ?").run(id);
}

/**
 * Marks a request answered, unless it already was. Returns false when another answer came
 * first, so the first answer wins.
 */
export function markAnswered(db: Db, id: number, connectionId: number, now: string): boolean {
  const result = db
    .prepare(
      `UPDATE suggestion_requests SET answered_at = ?, answered_by = ?
       WHERE id = ? AND answered_at IS NULL`,
    )
    .run(now, connectionId, id);
  return result.changes === 1;
}

/**
 * The requests still waiting for an answer, made since this time, on tickets that still wait
 * for a way to verify them: New, not archived and with no check. With onlyPressed, only the
 * ones a person pressed for. Oldest first.
 */
export function waitingRequests(db: Db, since: string, onlyPressed: boolean): RequestWithTicket[] {
  return db
    .prepare(
      `SELECT r.*, t.title, t.description
       FROM suggestion_requests r JOIN tickets t ON t.id = r.ticket_id
       WHERE r.answered_at IS NULL AND r.created_at >= ?
         AND (r.pressed = 1 OR ? = 0)
         AND t.status = 'new' AND t.archived_at IS NULL AND t.fix_check IS NULL
       ORDER BY r.id`,
    )
    .all(since, onlyPressed ? 1 : 0) as RequestWithTicket[];
}

/** Which of these connections are still live: not revoked and not expired. */
export function liveConnectionIds(db: Db, ids: number[], now: string): number[] {
  const rows = db
    .prepare(
      `SELECT id FROM agent_connections
       WHERE id IN (SELECT value FROM json_each(?))
         AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(JSON.stringify(ids), now) as { id: number }[];
  return rows.map((row) => row.id);
}

import type { Db } from "../db.js";

// The SQL for email notices. Every statement here is a fixed string.

/** One history event, as stored. data is JSON text. */
export type EventRow = {
  id: number;
  ticket_id: number;
  actor: string;
  actor_kind: "person" | "agent";
  type: string;
  data: string;
  created_at: string;
};

/** The id of the last history event the notifier has read. */
export function readCursor(db: Db): number {
  const row = db.prepare("SELECT last_event_id FROM email_outbox_cursor WHERE id = 1").get() as {
    last_event_id: number;
  };
  return row.last_event_id;
}

export function moveCursor(db: Db, lastEventId: number): void {
  db.prepare("UPDATE email_outbox_cursor SET last_event_id = ? WHERE id = 1").run(lastEventId);
}

/** The history events after this id, oldest first, at most this many. */
export function eventsAfter(db: Db, afterId: number, most: number): EventRow[] {
  return db
    .prepare(
      `SELECT id, ticket_id, actor, actor_kind, type, data, created_at
       FROM ticket_events WHERE id > ? ORDER BY id LIMIT ?`,
    )
    .all(afterId, most) as EventRow[];
}

/** What a notice needs to know about a ticket now. */
export type TicketFacts = {
  title: string;
  created_by: string | null;
  owner_id: string | null;
  owner_name: string | null;
  try_url: string | null;
};

export function ticketFacts(db: Db, ticketId: number): TicketFacts | undefined {
  return db
    .prepare("SELECT title, created_by, owner_id, owner_name, try_url FROM tickets WHERE id = ?")
    .get(ticketId) as TicketFacts | undefined;
}

/**
 * The data of the last change of owner on a ticket up to and including this event, as JSON
 * text, or undefined when the ticket had never had an owner by then.
 */
export function lastOwnerChangeData(db: Db, ticketId: number, eventId: number): string | undefined {
  const row = db
    .prepare(
      `SELECT data FROM ticket_events
       WHERE ticket_id = ? AND id <= ? AND type = 'owner_changed'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, eventId) as { data: string } | undefined;
  return row?.data;
}

/** A public reply, by who wrote it. */
export type PublicReply = { body: string; author_name: string };

/**
 * The public reply that a reply_added event recorded: same ticket, same author, same moment.
 * Only replies are read, never internal notes.
 */
export function publicReplyOf(db: Db, event: EventRow): PublicReply | undefined {
  return db
    .prepare(
      `SELECT body, author_name FROM ticket_entries
       WHERE ticket_id = ? AND author = ? AND created_at = ? AND kind = 'reply'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(event.ticket_id, event.actor, event.created_at) as PublicReply | undefined;
}

/**
 * A signed-in person's name and verified email address, from the sign-in library's table of
 * people. Undefined for anyone who has never signed in, such as the made-up people and
 * assistants. Sign-in already refuses an address that is not verified; the query says so too.
 */
export function personOf(db: Db, id: string): { name: string; email: string } | undefined {
  return db
    .prepare('SELECT name, email FROM "user" WHERE id = ? AND "emailVerified" = 1')
    .get(id) as { name: string; email: string } | undefined;
}

/** One stored notice. */
export type NoticeRow = {
  id: number;
  event_id: number;
  ticket_id: number;
  recipient_id: string;
  kind: string;
  address: string;
  subject: string;
  body: string;
  state: "pending" | "sent" | "failed" | "not_sent";
  not_sent_reason: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export type NewNotice = Pick<
  NoticeRow,
  | "event_id"
  | "ticket_id"
  | "recipient_id"
  | "kind"
  | "address"
  | "subject"
  | "body"
  | "state"
  | "not_sent_reason"
  | "created_at"
>;

/** Writes a notice unless the same one is already there. True when a row was added. */
export function insertNotice(db: Db, notice: NewNotice): boolean {
  const result = db
    .prepare(
      `INSERT INTO email_outbox
         (event_id, ticket_id, recipient_id, kind, address, subject, body, state,
          not_sent_reason, created_at, updated_at)
       VALUES
         (@event_id, @ticket_id, @recipient_id, @kind, @address, @subject, @body, @state,
          @not_sent_reason, @created_at, @created_at)
       ON CONFLICT (event_id, recipient_id, kind) DO NOTHING`,
    )
    .run(notice);
  return result.changes === 1;
}

/** Every notice about one ticket, oldest first. */
export function noticesOfTicket(db: Db, ticketId: number): NoticeRow[] {
  return db
    .prepare("SELECT * FROM email_outbox WHERE ticket_id = ? ORDER BY id")
    .all(ticketId) as NoticeRow[];
}

/** The notices about one ticket that went to one person, oldest first. */
export function noticesOfTicketFor(db: Db, ticketId: number, recipientId: string): NoticeRow[] {
  return db
    .prepare("SELECT * FROM email_outbox WHERE ticket_id = ? AND recipient_id = ? ORDER BY id")
    .all(ticketId, recipientId) as NoticeRow[];
}

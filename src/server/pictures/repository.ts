import type { Db } from "../db.js";
import type { PictureType } from "./kinds.js";

// The SQL for pictures. Every statement is a fixed string with ? placeholders.

/** One picture as listed: everything but its bytes. */
export type PictureRow = {
  id: number;
  ticket_id: number;
  entry_id: number | null;
  added_by: string;
  type: PictureType;
  size: number;
  shown_only_to: string | null;
  created_at: string;
};

export type NewPicture = Omit<PictureRow, "id"> & { bytes: Buffer };

export function insertPicture(db: Db, picture: NewPicture): number {
  const result = db
    .prepare(
      `INSERT INTO ticket_pictures
         (ticket_id, entry_id, added_by, type, size, bytes, shown_only_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      picture.ticket_id,
      picture.entry_id,
      picture.added_by,
      picture.type,
      picture.size,
      picture.bytes,
      picture.shown_only_to,
      picture.created_at,
    );
  return Number(result.lastInsertRowid);
}

/** Every picture on one ticket, oldest first, without their bytes. */
export function listPictures(db: Db, ticketId: number): PictureRow[] {
  return db
    .prepare(
      `SELECT id, ticket_id, entry_id, added_by, type, size, shown_only_to, created_at
       FROM ticket_pictures WHERE ticket_id = ? ORDER BY id`,
    )
    .all(ticketId) as PictureRow[];
}

/** The bytes of one picture on one ticket, or undefined when there is no such picture. */
export function pictureBytes(db: Db, ticketId: number, id: number): Buffer | undefined {
  const row = db
    .prepare("SELECT bytes FROM ticket_pictures WHERE ticket_id = ? AND id = ?")
    .get(ticketId, id) as { bytes: Buffer } | undefined;
  return row?.bytes;
}

export function countTicketPictures(db: Db, ticketId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ticket_pictures WHERE ticket_id = ?")
    .get(ticketId) as { n: number };
  return row.n;
}

/** On the demo: how many pictures its visitors have added, across every ticket. */
export function countVisitorPictures(db: Db): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ticket_pictures WHERE shown_only_to IS NOT NULL")
    .get() as { n: number };
  return row.n;
}

/** How many pictures were added with one message, for its email notice. */
export function countEntryPictures(db: Db, entryId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ticket_pictures WHERE entry_id = ?")
    .get(entryId) as { n: number };
  return row.n;
}

import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { NOT_SENT_REASONS, noticesForViewer, type VisibleNotice } from "./outbox.js";

// What the notices page shows of each notice: its state in plain words, newest first. The
// page itself is in routes/notices.ts and views/notices.ejs.

/** How each reason a notice was kept and not sent reads on the page. */
const NOT_SENT_WORDS = new Map<string, string>([
  [NOT_SENT_REASONS.demo, "Not sent: this demo never sends email"],
  [NOT_SENT_REASONS.noMailServer, "Not sent: no mail server is set up on this site"],
  [NOT_SENT_REASONS.madeUp, "Not sent: this person is made up and has no address"],
  [NOT_SENT_REASONS.unverified, "Not sent: the address is not verified"],
]);

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five"];

/** "five tries", "one try": a small count in words, then the noun. */
function tries(count: number): string {
  const number = COUNT_WORDS[count] ?? String(count);
  return count === 1 ? `${number} try` : `${number} tries`;
}

/** The state of one notice, in the words the page shows. */
export function noticeStateWords(notice: VisibleNotice): string {
  if (notice.state === "sent") return "Sent";
  if (notice.state === "failed") return `Failed after ${tries(notice.attempts)}`;
  if (notice.state === "not_sent") {
    return NOT_SENT_WORDS.get(notice.not_sent_reason ?? "") ?? "Not sent";
  }
  return "Waiting to be sent";
}

/** The notices of one ticket this viewer may see, newest first. */
export function noticesNewestFirst(db: Db, ticketId: number, viewer: Actor): VisibleNotice[] {
  return noticesForViewer(db, ticketId, viewer).reverse();
}

/**
 * How many notices of one ticket this viewer may see, for a short line on the ticket page that
 * links to the notices page. The caller has already checked that the viewer may read the ticket.
 */
export function noticeCountFor(db: Db, ticketId: number, viewer: Actor): number {
  return noticesForViewer(db, ticketId, viewer).length;
}

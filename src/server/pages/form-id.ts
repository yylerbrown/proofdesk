import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../actor.js";
import type { Ticket, TicketService } from "../tickets/service.js";

// Each new ticket form carries a one-time id in its address, so going Back after filing and
// pressing "File ticket" again finds the ticket already filed instead of filing a copy.
// The id is filed through the same idempotency helper the JSON API uses for its
// Idempotency-Key header. That helper keeps each id per person, so an id only ever answers
// the person who filed with it.

// 16 random bytes, written in base64url: 22 letters, digits, "-" or "_". Nobody can guess one.
const formIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** A new, unguessable form id. */
export function newFormId(): string {
  return randomBytes(16).toString("base64url");
}

/** The form id sent with a request, or null when there is none or it is not one of ours. */
export function readFormId(value: unknown): string | null {
  const result = formIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

// Kept apart from the keys API callers choose, and the same on every call for one form, so a
// second call with the same id always gets the first ticket back.
const idempotencyKey = (formId: string) => `ticket-form:${formId}`;
const ACTION = "create_ticket";

/**
 * Files a ticket at most once per form id. The first call runs fileTicket and returns its
 * ticket. Every later call with the same id returns that same ticket and files nothing.
 */
export function fileOnce(
  service: TicketService,
  actor: Actor,
  formId: string,
  fileTicket: () => Ticket,
): Ticket {
  return service.once(actor, idempotencyKey(formId), ACTION, "", null, fileTicket);
}

// Thrown to stop a lookup before anything is filed.
class NotFiledYet extends Error {}

/** The ticket this person already filed with this form id, or null if they have not. */
export function ticketFiledWith(
  service: TicketService,
  actor: Actor,
  formId: string,
): Ticket | null {
  try {
    // The helper returns the saved ticket when the id was used. When it was not, it calls
    // this function to file one, which stops it instead, so nothing is written.
    return fileOnce(service, actor, formId, () => {
      throw new NotFiledYet();
    });
  } catch (err) {
    if (err instanceof NotFiledYet) return null;
    throw err;
  }
}

/** Whether a ticket holds the text a form sends, compared the way filing stores it. */
export function sameText(
  ticket: Ticket,
  values: { title: string; description: string; where_url: string; fix_check: string },
): boolean {
  return (
    ticket.title === values.title.trim() &&
    ticket.description === values.description.trim() &&
    (ticket.where_url ?? "") === values.where_url.trim() &&
    (ticket.fix_check ?? "") === values.fix_check.trim()
  );
}

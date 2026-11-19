import type { Actor } from "../actor.js";
import { TICKET_STATUSES, type TicketStatus } from "../tickets/schemas.js";
import type { Ticket, TicketService } from "../tickets/service.js";

// The ticket page's status control, for the team: one row of the three statuses, New,
// In Progress and Resolved. The current one is marked. Each other one is a single press when
// this viewer may make that move, and a disabled button otherwise, with one short line saying
// why. Every press goes through the same service function as the rest of the product.

type Allowed = ReturnType<TicketService["allowedActions"]>;

/** One status in the row, and what pressing it does. */
export type StatusChoice =
  | { status: TicketStatus; kind: "current" }
  /** A form with one button, posted to this address with these fields. */
  | { status: TicketStatus; kind: "press"; action: string; fields: Record<string, string> }
  /** Opens the reason chooser in place, then resolves with that reason. */
  | { status: TicketStatus; kind: "resolve" }
  /** Opens the box for why, then reopens the ticket. */
  | { status: TicketStatus; kind: "reopen" }
  | { status: TicketStatus; kind: "disabled" };

/**
 * The row's choices, and one short line saying why some cannot be pressed, if any. When this
 * viewer can press none of them, pressable is false and the page shows the status in plain words
 * with that line, instead of a row of greyed buttons.
 */
export type StatusControl = { choices: StatusChoice[]; why: string | null; pressable: boolean };

/** The row for a team member or admin, or null for a customer, who has no status control. */
export function statusControl(
  ticket: Ticket,
  allowed: Allowed,
  actor: Actor,
): StatusControl | null {
  if (actor.role === "customer") return null;
  const choices = TICKET_STATUSES.map((status) => choiceFor(status, ticket, allowed, actor));
  const disabled = choices.filter((choice) => choice.kind === "disabled");
  const why = disabled.length === 0 ? null : whyDisabled(ticket, allowed, actor);
  const pressable = choices.some(
    (choice) => choice.kind !== "current" && choice.kind !== "disabled",
  );
  return { choices, why, pressable };
}

/** What pressing this status does for this viewer, if anything. */
function choiceFor(
  status: TicketStatus,
  ticket: Ticket,
  allowed: Allowed,
  actor: Actor,
): StatusChoice {
  const at = `/tickets/${ticket.key}`;
  if (status === ticket.status) return { status, kind: "current" };
  if (ticket.archived_at !== null || actor.readOnly === true) return { status, kind: "disabled" };
  if (ticket.status === "resolved") {
    // A resolved ticket comes back only by reopening it: to its owner, or to New with none.
    return status === reopenTarget(ticket) && allowed.reopen
      ? { status, kind: "reopen" }
      : { status, kind: "disabled" };
  }
  if (status === "resolved") {
    return allowed.resolveWithReason ? { status, kind: "resolve" } : { status, kind: "disabled" };
  }
  if (status === "in_progress") {
    // From New: take it and start work in one press, or start work on one this viewer owns.
    if (allowed.takeAndStart) {
      return { status, kind: "press", action: `${at}/take-and-start`, fields: {} };
    }
    if (allowed.start) return { status, kind: "press", action: `${at}/status`, fields: { status } };
    return { status, kind: "disabled" };
  }
  // Back to New, from In Progress.
  if (allowed.returnToNew)
    return { status, kind: "press", action: `${at}/status`, fields: { status } };
  return { status, kind: "disabled" };
}

/** Where reopening a resolved ticket takes it: back to its owner, or to New if it has none. */
function reopenTarget(ticket: Ticket): TicketStatus {
  return ticket.owner_id === null ? "new" : "in_progress";
}

/**
 * One short line saying why some of the row cannot be pressed by this viewer, or null when the
 * buttons already say it: a resolved ticket this viewer can reopen names where it goes.
 */
function whyDisabled(ticket: Ticket, allowed: Allowed, actor: Actor): string | null {
  if (ticket.archived_at !== null) return "It is archived. Restore it to change its status.";
  if (actor.readOnly === true) return "The preview is read-only.";
  const owner = ticket.owner_name === null ? "its owner" : `${ticket.owner_name}, who owns it,`;
  if (ticket.status === "resolved") {
    if (allowed.reopen) return null;
    if (ticket.resolution?.by === "customer") {
      return "Only the customer can reopen a ticket they confirmed.";
    }
    if (ticket.owner_id === null) return "Only an admin or the customer can reopen it.";
    return `Only ${owner} an admin or the customer can reopen it.`;
  }
  if (ticket.status === "in_progress") return `Only ${owner} or an admin can change its status.`;
  // New, owned by someone else: only they start work, and an admin may also resolve it.
  if (!allowed.resolveWithReason) {
    return `Only ${owner} can start work. Only they or an admin can resolve it.`;
  }
  return `Only ${owner} can start work.`;
}

import { z } from "zod";
import { TICKET_STATUSES, type TicketStatus } from "../tickets/schemas.js";
import type { Role } from "../actor.js";
import type { Ticket, TicketEvent } from "../tickets/service.js";

// Small functions that turn stored values into the words shown on a page.

export const STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  in_progress: "In Progress",
  resolved: "Resolved",
};

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

/** Turns a stored time such as "2026-11-17T19:56:00.000Z" into "17 Nov 2026, 19:56 UTC". */
export function formatTime(iso: string): string {
  return `${timeFormat.format(new Date(iso))} UTC`;
}

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// Each unit, and how many seconds it holds. The largest that fits is used.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** How long ago a stored time was, in plain words: "3 hours ago", "yesterday", "just now". */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return relativeFormat.format(-Math.floor(seconds / size), unit);
  }
  return "just now";
}

/** Who has to act next on a ticket, in the words the viewer should read. */
export function waitingOn(ticket: Ticket, viewer: Role): string {
  if (ticket.waiting_on === "nobody") return "Nobody";
  if (ticket.waiting_on === "customer") return viewer === "customer" ? "You" : "Customer";
  if (viewer === "customer") return "Support team";
  // After a no, the team sees why the ticket is back with them.
  return ticket.customer_answer?.fixed === false ? "Team: customer says it still fails" : "Team";
}

/**
 * When the customer confirmed the fix, or null. Only a resolved ticket whose latest answer to
 * "Did this fix it?" was yes counts: a proposed fix, a linked change or a ticket marked ready
 * does not, and neither does a ticket resolved before answers existed.
 */
export function confirmedAt(ticket: Ticket, events: TicketEvent[]): string | null {
  if (ticket.status !== "resolved") return null;
  const answer = [...events].reverse().find((event) => event.type === "customer_answered");
  if (answer === undefined) return null;
  const parsed = z.object({ fixed: z.literal(true) }).safeParse(answer.data);
  return parsed.success ? answer.created_at : null;
}

const statusChangeSchema = z.object({
  from: z.enum(TICKET_STATUSES),
  to: z.enum(TICKET_STATUSES),
});

// Both a change of owner and a change of the agreed check record { from, to } as text.
const ownerChangeSchema = z.object({ from: z.string().nullable(), to: z.string().nullable() });

const editSchema = z.object({ changes: z.record(z.string(), z.unknown()) });

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  where_url: "where it happened",
  fix_check: "how we will know it's fixed",
};

/** One line of plain words for a history entry. An unknown kind of entry shows its type. */
export function describeEvent(event: TicketEvent): string {
  if (event.type === "created") return "Ticket filed";
  if (event.type === "status_changed") {
    const change = statusChangeSchema.safeParse(event.data);
    if (change.success) {
      const from = STATUS_LABELS[change.data.from];
      const to = STATUS_LABELS[change.data.to];
      return `Status changed from ${from} to ${to}`;
    }
  }
  if (event.type === "edited") {
    const edit = editSchema.safeParse(event.data);
    if (edit.success) {
      const fields = Object.keys(edit.data.changes).map((field) => FIELD_LABELS[field] ?? field);
      return `Edited: ${fields.join(", ")}`;
    }
  }
  if (event.type === "owner_changed") {
    const owner = ownerChangeSchema.safeParse(event.data);
    if (owner.success) {
      return owner.data.to === null ? "Released, now without an owner" : `Owner: ${owner.data.to}`;
    }
  }
  if (event.type === "check_agreed") {
    const check = ownerChangeSchema.safeParse(event.data);
    if (check.success) {
      return check.data.to === null ? "Agreed check removed" : `Check agreed: ${check.data.to}`;
    }
  }
  if (event.type === "change_linked") return "Change link added";
  if (event.type === "ready_for_customer") return "Ready for the customer to check";
  if (event.type === "customer_answered") {
    const answer = z.object({ fixed: z.boolean() }).safeParse(event.data);
    if (answer.success) {
      return answer.data.fixed ? "Customer confirmed it is fixed" : "Customer says it is not fixed";
    }
  }
  if (event.type === "reply_added") return "Reply added";
  if (event.type === "evidence_added") return "Evidence attached";
  if (event.type === "spec_proposed") return "Test spec proposed";
  if (event.type === "spec_accepted") return "Test spec accepted";
  if (event.type === "spec_discarded") return "Test spec discarded";
  if (event.type === "note_added") return "Internal note added";
  if (event.type === "reopened") return "Reopened by the customer: still happening";
  if (event.type === "agent_handed" || event.type === "agent_handoff_ended") {
    const handoff = z
      .object({ connection: z.string(), reason: z.string().optional() })
      .safeParse(event.data);
    if (handoff.success) {
      return event.type === "agent_handed"
        ? `Handed to the AI assistant ${handoff.data.connection}`
        : `${handoff.data.connection} (AI assistant) stopped working on it: ${handoff.data.reason ?? "ended"}`;
    }
  }
  if (event.type === "question_withdrawn") return "Question to the customer withdrawn";
  if (event.type === "archived") return "Archived";
  if (event.type === "restored") return "Restored";
  return event.type;
}

/**
 * Who wrote a history entry, by display name. An AI agent is always marked, so it is never
 * taken for a person. The names of demo people already say "Demo".
 */
export function describeActor(event: TicketEvent, names: Map<string, string>): string {
  // An agent is named by the connection it came through, as recorded with the entry.
  const connectionName = (event.context as { connection_name?: unknown } | null)?.connection_name;
  const name =
    (typeof connectionName === "string" ? connectionName : undefined) ??
    names.get(event.actor) ??
    (event.actor_kind === "agent" ? event.actor : "Unknown person");
  return event.actor_kind === "agent" ? `${name} (AI agent)` : name;
}

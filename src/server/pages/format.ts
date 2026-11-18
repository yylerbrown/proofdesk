import { z } from "zod";
import { TICKET_STATUSES, type TicketStatus } from "../tickets/schemas.js";
import type { TicketEvent } from "../tickets/service.js";

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
  if (event.type === "note_added") return "Internal note added";
  if (event.type === "archived") return "Archived";
  if (event.type === "restored") return "Restored";
  return event.type;
}

/** Who wrote a history entry. An agent is always marked, so it is never taken for a person. */
export function describeActor(event: TicketEvent): string {
  return event.actor_kind === "agent" ? `${event.actor} (agent)` : event.actor;
}

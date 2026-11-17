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
  return event.type;
}

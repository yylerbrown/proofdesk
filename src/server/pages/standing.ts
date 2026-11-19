import type { Ticket } from "../tickets/service.js";

/** The customer's one line under the ticket's title: where it stands and whose turn it is. */
export type Standing = {
  text: string;
  /** Only the customer's own Yes shows the tick. */
  tick: boolean;
};

/**
 * The line the customer reads under their ticket's title, in plain words, such as "New, not yet
 * taken by the team" or "In Progress, with Demo Team Member". confirmed says whether their own Yes
 * resolved it, which is the one case that shows the tick.
 */
export function customerStanding(ticket: Ticket, confirmed: boolean): Standing {
  if (ticket.status === "resolved") {
    if (confirmed) return { text: "Resolved, customer confirmed", tick: true };
    if (ticket.resolution?.by === "team") return { text: "Resolved by the team", tick: false };
    return { text: "Resolved", tick: false };
  }
  if (ticket.status === "in_progress") {
    return { text: `In Progress, with ${ticket.owner_name ?? "the team"}`, tick: false };
  }
  if (ticket.owner_name === null) return { text: "New, not yet taken by the team", tick: false };
  return { text: `New, with ${ticket.owner_name}`, tick: false };
}

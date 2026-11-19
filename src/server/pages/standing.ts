import type { Ticket } from "../tickets/service.js";

/**
 * The customer's one line under the ticket's title: where it stands and whose turn it is. The
 * page writes the status word first, with its mark, then rest, then the day when there is one.
 */
export type Standing = {
  /** The words after the status word, such as ", with Demo Team Member". */
  rest: string;
  /** The day their own Yes resolved it, written after rest, or null. */
  day: string | null;
  /** Only the customer's own Yes shows the tick. */
  tick: boolean;
};

/**
 * The line the customer reads under their ticket's title, in plain words, such as "New, not yet
 * taken by the team" or "In Progress, with Demo Team Member". confirmed is when their own Yes
 * resolved it, or null; it is the one case that shows the tick, and the line then carries the
 * day, so the card under the check does not say it again.
 */
export function customerStanding(ticket: Ticket, confirmed: string | null): Standing {
  const plain = (rest: string): Standing => ({ rest, day: null, tick: false });
  if (ticket.status === "resolved") {
    if (confirmed !== null) return { rest: ", customer confirmed on ", day: confirmed, tick: true };
    if (ticket.resolution?.by === "team") {
      // Marked fixed: the line says so once, and the card under it asks "Did this fix it?".
      if (ticket.resolution.reason === "fixed_no_reply") {
        return plain(", the team says it is fixed");
      }
      return plain(" by the team");
    }
    return plain("");
  }
  if (ticket.status === "in_progress") return plain(`, with ${ticket.owner_name ?? "the team"}`);
  if (ticket.owner_name === null) return plain(", not yet taken by the team");
  return plain(`, with ${ticket.owner_name}`);
}

import { z } from "zod";
import {
  RESOLVE_REASON_LABELS,
  RESOLVE_REASONS,
  TICKET_STATUSES,
  type TicketStatus,
} from "../tickets/schemas.js";
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

/** What the list knows about a ticket besides the ticket itself. */
export type TurnFacts = {
  /** The customer's latest word is their reopening it. */
  reopened: boolean;
  /** The label of what the ticket's assistant last said it needs, for a viewer who may read notes. */
  signal: { label: string } | undefined;
};

/**
 * The short tag the list shows after a ticket's status when it is not simply the team's turn,
 * or null when there is nothing to flag. Each tag is a reason for someone to look at it.
 */
export function turnTag(ticket: Ticket, viewer: Role, facts: TurnFacts): string | null {
  // The customer meets one name for the question, whether the team asked it or marked it fixed.
  if (ticket.waiting_on === "customer") {
    return viewer === "customer" ? "Did this fix it?" : "Asked the customer";
  }
  if (viewer === "customer" && markedFixed(ticket)) return "Did this fix it?";
  // The rest are about the team's turn, which the customer is not told about.
  if (ticket.waiting_on !== "team" || viewer === "customer") return null;
  // What an assistant said it needs is what the team needs to see first.
  if (facts.signal?.label === "Assistant blocked:") return "Assistant is blocked";
  if (facts.signal?.label === "Review requested by") return "Assistant asks for review";
  // A No and a reopening are the same word from the customer.
  if (facts.reopened || ticket.customer_answer?.fixed === false) return "Customer says not fixed";
  return null;
}

/**
 * True for a ticket the team resolved as fixed that its customer has not confirmed yet. Their
 * Yes clears the team's reason, so such a ticket then reads as the customer's.
 */
export function markedFixed(ticket: Ticket): boolean {
  return (
    ticket.archived_at === null &&
    ticket.status === "resolved" &&
    ticket.resolution?.by === "team" &&
    ticket.resolution.reason === "fixed_no_reply"
  );
}

/** Where the team says it is fixed, as typed with "Fixed in", in one sentence. */
export function fixedInLine(note: string): string {
  return `Fixed in: ${note.replace(/\.$/, "")}.`;
}

/** The customer's latest word that the ticket is not fixed: a No, or their reopening it. */
export type NotFixed = { reopened: boolean; words: string | null; at: string };

const reopenedSchema = z.object({ reason: z.string() });

/**
 * What the customer last said is still wrong, while the ticket is open and nobody has asked
 * them again; otherwise null. Their reopening a ticket is newer than any answer before it, so
 * then their reopen words are shown, not an older No.
 */
export function customerSaysNotFixed(ticket: Ticket, events: TicketEvent[]): NotFixed | null {
  if (ticket.status === "resolved" || ticket.ready_at !== null) return null;
  const latest = [...events]
    .reverse()
    .find((event) => event.type === "customer_answered" || event.type === "reopened");
  if (latest?.type === "reopened") {
    const parsed = reopenedSchema.safeParse(latest.data);
    return {
      reopened: true,
      words: parsed.success ? parsed.data.reason : null,
      at: latest.created_at,
    };
  }
  const answer = ticket.customer_answer;
  if (answer === null || answer.fixed) return null;
  return { reopened: false, words: answer.comment, at: answer.at };
}

/**
 * The customer's word that it is not fixed, for the card at the top of the ticket page: only
 * while it is their latest word and nothing the team did since answered it. Once the team
 * resolved or reopened the ticket after that word, the card is not shown, since it would read as
 * the customer's current answer.
 */
export function notFixedCard(ticket: Ticket, events: TicketEvent[]): NotFixed | null {
  const said = customerSaysNotFixed(ticket, events);
  if (said === null) return null;
  const latest = [...events]
    .reverse()
    .find((event) =>
      ["customer_answered", "reopened", "resolved_by_team", "reopened_by_team"].includes(
        event.type,
      ),
    );
  return latest?.type === "resolved_by_team" || latest?.type === "reopened_by_team" ? null : said;
}

/**
 * When the customer confirmed the fix, or null. Only a resolved ticket whose latest answer to
 * "Did this fix it?" was yes counts: a proposed fix, a linked change or a ticket marked ready
 * does not, and neither does a ticket resolved before answers existed.
 */
export function confirmedAt(ticket: Ticket, events: TicketEvent[]): string | null {
  if (ticket.status !== "resolved") return null;
  // Resolved by the team, with a reason: an earlier Yes in the history does not make it confirmed.
  if (ticket.resolution?.by === "team") return null;
  const answer = [...events].reverse().find((event) => event.type === "customer_answered");
  if (answer === undefined) return null;
  const parsed = z.object({ fixed: z.literal(true) }).safeParse(answer.data);
  return parsed.success ? answer.created_at : null;
}

const dayFormat = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" });

/** Turns a stored time such as "2026-11-17T19:56:00.000Z" into "17 Nov 2026". */
export function formatDay(iso: string): string {
  return dayFormat.format(new Date(iso));
}

/** What the ticket page knows besides the ticket, for the card's line. */
export type CardFacts = {
  /** When the customer's Yes resolved it, from confirmedAt. */
  confirmed: string | null;
  /** The customer's standing word that it is not fixed, from notFixedCard. */
  notFixed: NotFixed | null;
  /** The name of the assistant that asks for a review, for a viewer who may read notes. */
  reviewBy: string | null;
};

/** The one line on the card under the customer's check. */
export type CardLine = {
  /** The words before the line's day, or all of its words when it names no day. */
  text: string;
  /**
   * The stored time of the day the line names, or null. The page shows it as a <time> after
   * text, so the visitor's browser writes the day in their own time zone like every other time.
   */
  day: string | null;
  /** The words after the day. */
  after: string;
  /** Only the customer's Yes shows the tick. */
  tick: boolean;
  /** When the customer's own message about it was written, so the line can link to it. */
  messageAt: string | null;
};

/**
 * The line the card at the top of the ticket page shows under the customer's check: where the
 * ticket stands, for this viewer. Null when there is nothing to say, which is most of the time:
 * a ticket that is simply with the team needs no sentence. The customer's own words are never
 * repeated here: they stand in the conversation, and the line links to them.
 */
export function cardLine(ticket: Ticket, viewer: Role, facts: CardFacts): CardLine | null {
  const team = viewer !== "customer";
  // A line of words, with a day in the middle when it names one.
  const line = (
    text: string,
    day: string | null = null,
    after = "",
    messageAt: string | null = null,
  ): CardLine => ({ text, day, after, tick: false, messageAt });

  if (ticket.archived_at !== null) {
    if (!team) return null;
    return line("Archived on ", ticket.archived_at, ". Hidden from the lists until restored.");
  }

  if (ticket.status === "resolved") {
    if (facts.confirmed !== null) {
      return { ...line("Customer confirmed on ", facts.confirmed, "."), tick: true };
    }
    const resolution = ticket.resolution;
    if (resolution === null || resolution.by !== "team") return null;
    // For the team: what they said, then who resolved it and when, such as "Demo Team Member,
    // 19 Nov 2026", then what the customer has done about it.
    const name = resolution.resolved_by_name;
    const teamLine = (resolved: string, after: string): CardLine => {
      if (resolution.at) {
        const byWhom = name === null ? " " : ` ${name}, `;
        return line(`${resolved}${byWhom}`, resolution.at, `. ${after}`);
      }
      const byline = name === null ? "" : ` ${name}.`;
      return line(`${resolved}${byline} ${after}`);
    };
    if (resolution.reason === "fixed_no_reply") {
      // The customer has the question "Did this fix it?" in place of this line.
      if (!team) return null;
      const fixedIn = resolution.note ? ` ${fixedInLine(resolution.note)}` : "";
      return teamLine(
        `Resolved by the team: ${resolution.reason_label}${fixedIn}`,
        "The customer did not confirm it, and can reopen it.",
      );
    }
    // Most notes end in a full stop; the line's own full stop follows the bracket.
    const note = resolution.note ? ` (${resolution.note.replace(/\.$/, "")})` : "";
    const resolved = `Resolved by the team: ${resolution.reason_label}${note}.`;
    if (!team) return line(`${resolved} You have not confirmed it.`);
    return teamLine(resolved, "Not confirmed by the customer.");
  }

  // Asked: the customer has the question itself, as the card's heading.
  if (ticket.ready_at !== null) {
    if (!team) return null;
    return line("Waiting for the customer's answer. Asked ", ticket.ready_at, ".");
  }

  if (facts.notFixed !== null) {
    const at = facts.notFixed.at;
    // A No and a reopening read the same: the customer's word that it is not fixed.
    return team
      ? line("The customer says it is not fixed, since ", at, ".", at)
      : line("You said it is not fixed on ", at, ".", at);
  }

  if (team && facts.reviewBy !== null) return line(`${facts.reviewBy} asks for your review.`);
  return null;
}

const statusChangeSchema = z.object({
  from: z.enum(TICKET_STATUSES),
  to: z.enum(TICKET_STATUSES),
});

// Both a change of owner and a change of the team's check record { from, to } as text.
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
      return owner.data.to === null ? "Unassigned" : `Assigned to ${owner.data.to}`;
    }
  }
  if (event.type === "check_agreed") {
    const check = ownerChangeSchema.safeParse(event.data);
    if (check.success) {
      return check.data.to === null ? "Team's check removed" : `Team's check: ${check.data.to}`;
    }
  }
  if (event.type === "change_linked") return "Change link added";
  if (event.type === "ready_for_customer") return "Ready for the customer to check";
  if (event.type === "customer_answered") {
    const answer = z.object({ fixed: z.boolean() }).safeParse(event.data);
    if (answer.success) {
      return answer.data.fixed ? "Customer confirmed" : "Customer says it is not fixed";
    }
  }
  if (event.type === "reply_added") return "Reply added";
  if (event.type === "evidence_added") return "Evidence added";
  if (event.type === "spec_proposed") return "Suggested test added";
  if (event.type === "spec_accepted") return "Suggested test accepted as the agreed test";
  if (event.type === "spec_discarded") return "Suggested test discarded";
  if (event.type === "note_added") return "Internal note added";
  if (event.type === "review_requested") return "Review of the evidence requested";
  if (event.type === "reopened") {
    const reopened = reopenedSchema.safeParse(event.data);
    if (reopened.success) return `Reopened by the customer: ${reopened.data.reason}`;
    return "Reopened by the customer";
  }
  if (event.type === "reopened_by_team") {
    const reopened = z.object({ reason: z.string() }).safeParse(event.data);
    if (reopened.success) return `Reopened by the team: ${reopened.data.reason}`;
  }
  if (event.type === "resolved_by_team") {
    const resolved = z
      .object({
        reason: z.enum(RESOLVE_REASONS),
        note: z.string().nullable(),
        duplicate_of: z.string().nullable(),
      })
      .safeParse(event.data);
    if (resolved.success) {
      const { reason, note, duplicate_of } = resolved.data;
      const why =
        reason === "duplicate" && duplicate_of
          ? `Duplicate of ${duplicate_of}`
          : RESOLVE_REASON_LABELS[reason];
      if (reason === "fixed_no_reply" && note)
        return `Resolved by the team: ${why} ${fixedInLine(note)}`;
      return `Resolved by the team: ${why}${note ? ` (${note})` : ""}`;
    }
  }
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
  if (event.type === "check_adopted")
    return "The customer adopted the team's wording as their check";
  if (event.type === "archived") return "Archived";
  if (event.type === "restored") return "Restored";
  return event.type;
}

/**
 * A note split at its first blank line: the first paragraph, and the rest, or null when the
 * note is one paragraph. Windows line endings count as line endings.
 */
export function firstParagraph(text: string): { first: string; rest: string | null } {
  const paragraphs = text.trim().split(/\r?\n[ \t]*\r?\n/);
  const first = paragraphs[0] ?? "";
  const rest = paragraphs.slice(1).join("\n\n").trim();
  return { first, rest: rest === "" ? null : rest };
}

/**
 * Who wrote a history entry, by display name. An AI assistant is always marked, so it is never
 * taken for a person. The names of demo people already say "Demo".
 */
export function describeActor(event: TicketEvent, names: Map<string, string>): string {
  // An agent is named by the connection it came through, as recorded with the entry.
  const connectionName = (event.context as { connection_name?: unknown } | null)?.connection_name;
  const name =
    (typeof connectionName === "string" ? connectionName : undefined) ??
    names.get(event.actor) ??
    (event.actor_kind === "agent" ? event.actor : "Unknown person");
  return event.actor_kind === "agent" ? `${name} (AI assistant)` : name;
}

/**
 * The top-level plain fields of a report in a format Proofdesk does not read, as sent: at most
 * twelve, each value cut to 200 characters, and how many other fields were left out.
 */
export function reportFields(report: unknown): {
  fields: { name: string; value: string }[];
  more: number;
} {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return { fields: [], more: 0 };
  }
  const entries = Object.entries(report as Record<string, unknown>);
  const fields = entries
    .filter(([, value]) => value === null || ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 12)
    .map(([name, value]) => ({ name, value: String(value).slice(0, 200) }));
  return { fields, more: entries.length - fields.length };
}

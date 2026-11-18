import { z } from "zod";
import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { buildKey } from "../tickets/keys.js";
import { RESOLVE_REASON_LABELS, RESOLVE_REASONS } from "../tickets/schemas.js";
import { composeNotice } from "./compose.js";
import * as repository from "./repository.js";
import { noticesFor, type EventFacts, type PlannedNotice } from "./rules.js";

// The outbox: notices worked out from the ticket history. collectNotices reads the events after
// the cursor, writes a row for each notice the rules allow, and moves the cursor, in one
// transaction. Nothing here sends anything; a later step does that from the pending rows.

/** What collecting needs from the server's settings. */
export type NotifySettings = {
  /** The ticket key prefix, such as "SUP". */
  ticketPrefix: string;
  /** The site's public address, for the link in each notice. */
  siteUrl: string;
  /** True on the public demo, which never sends email. */
  demo: boolean;
  /** True when a mail server is set up to send through. */
  mailConfigured: boolean;
};

/** How many history events one call reads at most. The next call carries on from there. */
export const EVENTS_PER_COLLECT = 500;

/** The reasons a notice is kept but not sent. */
export const NOT_SENT_REASONS = {
  demo: "This is the demo, which never sends email.",
  noMailServer: "Email is off on this site: no mail server is set up.",
} as const;

/**
 * Reads the history events after the cursor, writes their notices and moves the cursor past
 * them, all in one transaction. Running it twice, or from two processes at once, adds nothing
 * twice: the transaction takes the write lock before reading, and a notice is unique on its
 * event, recipient and kind. Returns how many events were read and notices written.
 */
export function collectNotices(
  db: Db,
  settings: NotifySettings,
): { events: number; notices: number } {
  const collect = db.transaction(() => {
    const events = repository.eventsAfter(db, repository.readCursor(db), EVENTS_PER_COLLECT);
    let notices = 0;
    for (const event of events) {
      for (const notice of writeNoticesOf(db, event, settings)) {
        if (repository.insertNotice(db, notice)) notices += 1;
      }
    }
    const last = events.at(-1);
    if (last !== undefined) repository.moveCursor(db, last.id);
    return { events: events.length, notices };
  });
  return collect.immediate();
}

/** The rows one history event gives: one per notice the rules allow, to someone with an address. */
function writeNoticesOf(
  db: Db,
  event: repository.EventRow,
  settings: NotifySettings,
): repository.NewNotice[] {
  const ticket = repository.ticketFacts(db, event.ticket_id);
  if (ticket === undefined) return [];
  const data = parseData(event.data);
  const reply = event.type === "reply_added" ? repository.publicReplyOf(db, event) : undefined;
  const facts: EventFacts = {
    type: event.type,
    actorId: event.actor,
    actorKind: event.actor_kind,
    data,
    customerId: ticket.created_by,
    ownerId: ownerConcerned(db, event, ticket),
    replyAuthorRole: reply?.author_role ?? null,
  };

  const rows: repository.NewNotice[] = [];
  for (const planned of noticesFor(facts)) {
    const recipient = repository.personOf(db, planned.recipientId);
    // Someone with no stored address cannot be emailed.
    if (recipient === undefined || recipient.email === "") continue;
    if (!wantsEmail()) continue;
    const ticketKey = buildKey(settings.ticketPrefix, event.ticket_id);
    const { subject, body } = composeNotice({
      kind: planned.kind,
      ticketKey,
      title: ticket.title,
      siteUrl: settings.siteUrl.replace(/\/+$/, ""),
      recipientName: recipient.name,
      actorName: actorName(db, event, planned, reply),
      publicText: publicText(planned, data, reply),
      tryUrl: planned.kind === "asked_to_check" ? stringField(data, "try_url") : null,
      resolvedReason: planned.kind === "resolved_by_team" ? resolvedReason(data) : null,
    });
    const notSent = notSentReason(settings);
    rows.push({
      event_id: event.id,
      ticket_id: event.ticket_id,
      recipient_id: planned.recipientId,
      kind: planned.kind,
      address: recipient.email,
      subject,
      body,
      state: notSent === null ? "pending" : "not_sent",
      not_sent_reason: notSent,
      created_at: new Date().toISOString(),
    });
  }
  return rows;
}

/**
 * Whether the person wants email about their tickets. There is no switch for it yet, so
 * everyone does. A per-person "Email me" setting is checked here once it exists, read by the
 * person's id.
 */
function wantsEmail(): boolean {
  return true;
}

/** Why a notice is kept and not sent, or null when it should be sent. */
function notSentReason(settings: NotifySettings): string | null {
  if (settings.demo) return NOT_SENT_REASONS.demo;
  if (!settings.mailConfigured) return NOT_SENT_REASONS.noMailServer;
  return null;
}

/**
 * The owner an event concerns: whoever owned the ticket when it happened (for a hand-off, the
 * new owner). The history keeps owners by name, not by id, so the notice goes to the ticket's
 * owner now, and only while that is still the owner of the moment. If the ticket has changed
 * hands since, nobody is told: the new owner hears of it through their own hand-off notice.
 */
function ownerConcerned(
  db: Db,
  event: repository.EventRow,
  ticket: repository.TicketFacts,
): string | null {
  const change = repository.lastOwnerChangeData(db, event.ticket_id, event.id);
  if (change === undefined) return null;
  const ownerThen = stringField(parseData(change), "to");
  if (ownerThen === null || ticket.owner_name !== ownerThen) return null;
  return ticket.owner_id;
}

/** Who did it, by the name the recipient knows them by. */
function actorName(
  db: Db,
  event: repository.EventRow,
  planned: PlannedNotice,
  reply: repository.PublicReply | undefined,
): string {
  if (reply !== undefined) return reply.author_name;
  const person = repository.personOf(db, event.actor);
  if (person !== undefined) return person.name;
  // The owner hears from a customer; the customer hears from the team.
  return planned.audience === "owner" ? "The customer" : "The support team";
}

/** The public words a notice quotes: the reply, or the customer's words with a No or a reopen. */
function publicText(
  planned: PlannedNotice,
  data: unknown,
  reply: repository.PublicReply | undefined,
): string | null {
  if (planned.kind === "team_replied" || planned.kind === "customer_replied") {
    return reply?.body ?? null;
  }
  if (planned.kind === "customer_said_no") return stringField(data, "comment");
  if (planned.kind === "customer_reopened") return stringField(data, "reason");
  return null;
}

const resolvedSchema = z.object({
  reason: z.enum(RESOLVE_REASONS),
  duplicate_of: z.string().nullable().optional(),
});

/** The team's reason for resolving, in the words the ticket page uses. Never the free note. */
function resolvedReason(data: unknown): string | null {
  const resolved = resolvedSchema.safeParse(data);
  if (!resolved.success) return null;
  if (resolved.data.reason === "duplicate" && resolved.data.duplicate_of) {
    return `Duplicate of ${resolved.data.duplicate_of}`;
  }
  return RESOLVE_REASON_LABELS[resolved.data.reason];
}

function parseData(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** One text field of an event's data, or null when it is missing or not text. */
function stringField(data: unknown, name: string): string | null {
  const field = z.object({ [name]: z.string() }).safeParse(data);
  return field.success ? (field.data[name] as string) : null;
}

/**
 * The notices about one ticket that this viewer may see. A customer sees only the notices that
 * went to them. The team sees all of the ticket's. An assistant sees none. The caller has
 * already checked that the viewer may read the ticket.
 */
export function noticesForViewer(db: Db, ticketId: number, viewer: Actor): repository.NoticeRow[] {
  if (viewer.kind !== "person") return [];
  if (viewer.role === "team" || viewer.role === "admin") {
    return repository.noticesOfTicket(db, ticketId);
  }
  return repository.noticesOfTicketFor(db, ticketId, viewer.id);
}

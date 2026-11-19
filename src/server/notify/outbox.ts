import { z } from "zod";
import { entrancePeople, type Actor, type Role } from "../actor.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { OTHER_DEMO_CUSTOMERS } from "../demo.js";
import { emailMeOf } from "../people/repository.js";
import { roleNowOf } from "../people/role-now.js";
import { buildKey } from "../tickets/keys.js";
import { RESOLVE_REASON_LABELS, RESOLVE_REASONS } from "../tickets/schemas.js";
import { composeNotice } from "./compose.js";
import { countEntryPictures } from "../pictures/repository.js";
import * as repository from "./repository.js";
import { noticesFor, type EventFacts, type PlannedNotice } from "./rules.js";

// The outbox: notices worked out from the ticket history. collectNotices reads the events after
// the cursor, writes a row for each notice the rules allow, and moves the cursor, in one
// transaction. Nothing here sends anything: send.ts does that from the pending rows.

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
  /**
   * The made-up people of the demo or the development entrance. They never signed in, so they
   * have no address, but their notices are still written, as not sent, so the page can show
   * what would have been emailed.
   */
  madeUpPeople: readonly MadeUpPerson[];
  /**
   * A person's role at this moment, or undefined for nobody. An owner notice quotes the
   * customer, so it goes only to someone who is on the team when it is written. It is required,
   * so a caller cannot leave the check out by mistake.
   */
  roleNow: (db: Db, personId: string) => Role | undefined;
};

/**
 * The notice settings of this server. The link in each notice goes to its public address: the
 * one set for it, or the one GitHub sign-in returns to, or this machine for development.
 */
export function notifySettingsOf(config: Config): NotifySettings {
  return {
    ticketPrefix: config.ticketPrefix,
    siteUrl: config.publicUrl ?? config.signIn?.baseUrl ?? `http://localhost:${config.port}`,
    demo: config.demo,
    mailConfigured: config.mail !== null,
    madeUpPeople: madeUpPeopleOf(config),
    roleNow: (db, personId) => roleNowOf(config, db, personId),
  };
}

/** A made-up person, by id and display name. */
export type MadeUpPerson = { id: string; name: string };

/**
 * The made-up people this server has: those of its sign-in page, and on the demo also the
 * customers who filed some of the sample tickets.
 */
export function madeUpPeopleOf(config: Config): MadeUpPerson[] {
  const people = entrancePeople(config).map(({ id, name }) => ({ id, name }));
  if (!config.demo) return people;
  return [...people, ...OTHER_DEMO_CUSTOMERS.map(({ id, name }) => ({ id, name }))];
}

/** How many history events one call reads at most. The next call carries on from there. */
export const EVENTS_PER_COLLECT = 500;

/**
 * How many notices about one ticket one person is sent in an hour at most. Past it, the next
 * ones are still written, as not sent with a reason, so the ticket's notices page says so.
 */
export const NOTICES_PER_TICKET_PER_HOUR = 10;

const HOUR_MS = 60 * 60 * 1000;

/** The reasons a notice is kept but not sent. */
export const NOT_SENT_REASONS = {
  demo: "This is the demo, which never sends email.",
  madeUp: "This person is made up and has no address.",
  noMailServer: "Email is off on this site: no mail server is set up.",
  unverified: "This person's email address is not verified, so no email goes to it.",
  switchedOff: "This person switched off email about their tickets before it was sent.",
  tooMany: "Too many notices about this ticket in an hour, so this one was not sent.",
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

/**
 * The rows one history event gives: one per notice the rules allow, to someone with an address
 * or to one of the made-up people.
 */
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
    replyByFiler: reply === undefined ? null : event.actor === ticket.created_by,
  };

  const rows: repository.NewNotice[] = [];
  for (const planned of noticesFor(facts)) {
    const recipient = recipientOf(db, planned.recipientId, settings);
    // Someone with no stored address, who is not one of the made-up people, gets no row.
    if (recipient === undefined) continue;
    if (!wantsEmail(db, planned.recipientId)) continue;
    // An owner notice quotes the customer, so only someone on the team now may get it. A team
    // member who was made a customer still owns their resolved tickets, and hears nothing more.
    if (planned.audience === "owner" && !onTheTeam(settings.roleNow(db, planned.recipientId))) {
      continue;
    }
    const ticketKey = buildKey(settings.ticketPrefix, event.ticket_id);
    const { subject, body } = composeNotice({
      kind: planned.kind,
      ticketKey,
      title: ticket.title,
      siteUrl: settings.siteUrl.replace(/\/+$/, ""),
      recipientName: recipient.name,
      actorName: actorName(db, event, planned, reply, settings),
      publicText: publicText(planned, data, reply),
      tryUrl: planned.kind === "asked_to_check" ? stringField(data, "try_url") : null,
      resolvedReason: planned.kind === "resolved_by_team" ? resolvedReason(data) : null,
      customerCheck: planned.kind === "marked_fixed" ? ticket.fix_check : null,
      pictureCount: reply === undefined ? 0 : countEntryPictures(db, reply.id),
    });
    const createdAt = new Date();
    const notSent =
      notSentReason(settings, recipient) ??
      overHourlyCap(db, event.ticket_id, planned.recipientId, createdAt);
    rows.push({
      event_id: event.id,
      ticket_id: event.ticket_id,
      recipient_id: planned.recipientId,
      kind: planned.kind,
      address: recipient.address,
      subject,
      body,
      state: notSent === null ? "pending" : "not_sent",
      not_sent_reason: notSent,
      created_at: createdAt.toISOString(),
    });
  }
  return rows;
}

/** Whether a role is one of the team's. */
function onTheTeam(role: Role | undefined): boolean {
  return role === "team" || role === "admin";
}

/**
 * The reason for holding a notice back when this person has already been sent, or is waiting
 * for, NOTICES_PER_TICKET_PER_HOUR notices about this ticket in the last hour; otherwise null.
 */
function overHourlyCap(db: Db, ticketId: number, recipientId: string, now: Date): string | null {
  const since = new Date(now.getTime() - HOUR_MS).toISOString();
  const recent = repository.countRecentNotices(db, ticketId, recipientId, since);
  return recent >= NOTICES_PER_TICKET_PER_HOUR ? NOT_SENT_REASONS.tooMany : null;
}

/**
 * Whether the person wants email about their tickets: the "Email me about my tickets" switch
 * on their account page, which is on until they switch it off.
 */
function wantsEmail(db: Db, personId: string): boolean {
  return emailMeOf(db, personId);
}

/**
 * Who a notice goes to: a name and an address, which is empty for a made-up person, and
 * whether the address is verified.
 */
type Recipient = { name: string; address: string; madeUp: boolean; verified: boolean };

/** The recipient with this id, or undefined when there is nobody to write to. */
function recipientOf(db: Db, id: string, settings: NotifySettings): Recipient | undefined {
  const person = repository.personOf(db, id);
  if (person !== undefined && person.email !== "") {
    return { name: person.name, address: person.email, madeUp: false, verified: person.verified };
  }
  const madeUp = settings.madeUpPeople.find((someone) => someone.id === id);
  if (madeUp !== undefined)
    return { name: madeUp.name, address: "", madeUp: true, verified: false };
  return undefined;
}

/** Why a notice is kept and not sent, or null when it should be sent. */
function notSentReason(settings: NotifySettings, recipient: Recipient): string | null {
  if (settings.demo) return NOT_SENT_REASONS.demo;
  // A made-up person has no address, so their notice is never sent.
  if (recipient.madeUp) return NOT_SENT_REASONS.madeUp;
  // Only an address GitHub verified is ever mailed.
  if (!recipient.verified) return NOT_SENT_REASONS.unverified;
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
  settings: NotifySettings,
): string {
  if (reply !== undefined) return reply.author_name;
  const person = repository.personOf(db, event.actor);
  if (person !== undefined) return person.name;
  const madeUp = settings.madeUpPeople.find((someone) => someone.id === event.actor);
  if (madeUp !== undefined) return madeUp.name;
  // Only the team hands a ticket on. Otherwise the owner hears from the customer, and the
  // customer hears from the team.
  if (planned.kind === "handed_to_you") return "A teammate";
  return planned.audience === "owner" ? "The customer" : "The support team";
}

/**
 * The public words a notice quotes: the reply, the customer's words with a No or a reopen, or
 * the team's note with a resolution, which the ticket page shows the customer too.
 */
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
  if (planned.kind === "resolved_by_team" || planned.kind === "marked_fixed") {
    return stringField(data, "note");
  }
  return null;
}

const resolvedSchema = z.object({
  reason: z.enum(RESOLVE_REASONS),
  duplicate_of: z.string().nullable().optional(),
});

/** The team's reason for resolving, in the words the ticket page uses. */
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
export function noticesForViewer(db: Db, ticketId: number, viewer: Actor): VisibleNotice[] {
  if (viewer.kind !== "person") return [];
  const rows =
    viewer.role === "team" || viewer.role === "admin"
      ? repository.noticesOfTicket(db, ticketId)
      : repository.noticesOfTicketFor(db, ticketId, viewer.id);
  return rows.map(withoutAddress);
}

/**
 * A notice as a page may show it: without the address. No page shows anyone's email address
 * today, and a team member has no need of a customer's to see that they were told.
 */
export type VisibleNotice = Omit<repository.NoticeRow, "address">;

function withoutAddress(row: repository.NoticeRow): VisibleNotice {
  const visible: Partial<repository.NoticeRow> = { ...row };
  delete visible.address;
  return visible as VisibleNotice;
}

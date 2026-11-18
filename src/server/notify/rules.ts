import { z } from "zod";
import type { Role } from "../actor.js";

// Who is told about what. Notices are worked out from the ticket history, so the ticket rules
// know nothing about email. This file is the whole list: an event type that is not on it sends
// nothing, so a new kind of event stays silent until someone decides who should hear about it.

/** The two people a notice can go to: the customer who filed the ticket, or its owner. */
export type Audience = "customer" | "owner";

/** What a notice is about. Each kind has its own subject and wording. */
export type NoticeKind =
  | "asked_to_check"
  | "team_replied"
  | "resolved_by_team"
  | "handed_to_you"
  | "customer_said_no"
  | "customer_replied"
  | "customer_reopened";

/**
 * The allowlist: for each history event type, who may be told. Everything left out is never
 * told to anyone, among them internal notes, an assistant's work, evidence and test specs.
 */
export const TOLD: ReadonlyMap<string, readonly Audience[]> = new Map<string, Audience[]>([
  // The team asked the customer "Did this fix it?".
  ["ready_for_customer", ["customer"]],
  // A public reply: from the team it goes to the customer, from the customer to the owner.
  ["reply_added", ["customer", "owner"]],
  // The team resolved it with a reason, so the customer knows they can reopen it.
  ["resolved_by_team", ["customer"]],
  // The ticket was handed to a new owner.
  ["owner_changed", ["owner"]],
  // The customer answered "Did this fix it?". Only a No needs the owner.
  ["customer_answered", ["owner"]],
  // The customer reopened a resolved ticket.
  ["reopened", ["owner"]],
]);

/** What one history event says, with the people it concerns. */
export type EventFacts = {
  type: string;
  actorId: string;
  actorKind: "person" | "agent";
  data: unknown;
  /** The person who filed the ticket. */
  customerId: string | null;
  /** The ticket's owner that the event concerns: for a hand-off, the new owner. */
  ownerId: string | null;
  /** For reply_added: the role of the public reply's author, or null when there is none. */
  replyAuthorRole: Role | null;
};

/** One notice to write: to whom, of what kind, and as which of the two audiences. */
export type PlannedNotice = { recipientId: string; kind: NoticeKind; audience: Audience };

const answerSchema = z.object({ fixed: z.boolean() });

/** The notices one history event gives, after every rule below. Often none. */
export function noticesFor(facts: EventFacts): PlannedNotice[] {
  const allowed = TOLD.get(facts.type);
  if (allowed === undefined) return [];
  // An assistant's work is never mailed to anyone.
  if (facts.actorKind === "agent") return [];

  const planned = candidates(facts).filter((notice) => allowed.includes(notice.audience));
  return planned.filter((notice) => {
    // Nobody is told about their own action.
    if (notice.recipientId === facts.actorId) return false;
    // An assistant connection is never a recipient.
    if (isConnectionId(notice.recipientId)) return false;
    return true;
  });
}

/** The notices an allowed event could give, before the checks every notice must pass. */
function candidates(facts: EventFacts): PlannedNotice[] {
  const toCustomer = (kind: NoticeKind): PlannedNotice[] =>
    facts.customerId === null
      ? []
      : [{ recipientId: facts.customerId, kind, audience: "customer" }];
  const toOwner = (kind: NoticeKind): PlannedNotice[] =>
    facts.ownerId === null ? [] : [{ recipientId: facts.ownerId, kind, audience: "owner" }];

  switch (facts.type) {
    case "ready_for_customer":
      return toCustomer("asked_to_check");
    case "reply_added":
      // No public reply found: nothing to tell, rather than guess.
      if (facts.replyAuthorRole === null) return [];
      return facts.replyAuthorRole === "customer"
        ? toOwner("customer_replied")
        : toCustomer("team_replied");
    case "resolved_by_team":
      return toCustomer("resolved_by_team");
    case "owner_changed":
      return toOwner("handed_to_you");
    case "customer_answered": {
      const answer = answerSchema.safeParse(facts.data);
      if (!answer.success || answer.data.fixed) return [];
      return toOwner("customer_said_no");
    }
    case "reopened":
      return toOwner("customer_reopened");
    default:
      return [];
  }
}

/** The ids of AI assistants' connections look like "connection-12". */
function isConnectionId(id: string): boolean {
  return id.startsWith("connection-");
}

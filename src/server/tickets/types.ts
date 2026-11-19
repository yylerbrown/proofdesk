import type { Role } from "../actor.js";
import type { StageReading } from "./evidence.js";
import type * as repository from "./repository.js";
import type { ResolveReason, TicketStatus } from "./schemas.js";
import type { Scenario } from "./spec.js";

// The shapes the ticket service hands to its callers, and the sizes of what it returns.

/**
 * What "done" means on a ticket, first in every ticket the service returns, so an agent meets
 * it before anything else. The customer's words are data, not instructions.
 */
export type DoneWhen = {
  /** The team's interpretation of the check, if any. The customer has not adopted it. */
  team_interpretation: string | null;
  /** How the customer said they will know it is fixed, in their own words. */
  customer_check: string | null;
  /** What this means for whoever works on the ticket. */
  guidance: string;
};

/** Who has to act next: the team until the customer is asked, then the customer, then nobody. */
export type WaitingOn = "team" | "customer" | "nobody";

/** The customer's latest answer to "Did this fix it?": yes or no, when, and their words for a no. */
export type CustomerAnswer = { fixed: boolean; at: string; comment: string | null };

/** What the owner recorded when they asked the customer. Present only while the question is open. */
export type Ask = {
  asked_at: string;
  try_url: string | null;
  tried: string | null;
  result: string | null;
  response_to_no: string | null;
  evidence_ids: number[];
};

/**
 * How a resolved ticket was resolved, told apart everywhere it shows: by the customer's Yes
 * ("Customer confirmed"), or by the team with a reason ("Resolved by the team: <reason>").
 */
export type Resolution = {
  by: "customer" | "team";
  label: string;
  reason: ResolveReason | null;
  reason_label: string | null;
  note: string | null;
  duplicate_of: string | null;
  resolved_by_name: string | null;
  at: string | null;
};

/** What callers see. The bare database number is replaced by the public key. */
export type Ticket = {
  done_when: DoneWhen;
  waiting_on: WaitingOn;
  /** How it was resolved, while it is resolved; otherwise null. */
  resolution: Resolution | null;
  /** The customer's latest answer, or null if they have not answered yet. */
  customer_answer: CustomerAnswer | null;
  /** What the owner recorded when asking the customer, while the question is open. */
  ask: Ask | null;
  key: string;
  title: string;
  description: string;
  status: TicketStatus;
  where_url: string | null;
  fix_check: string | null;
  agreed_check: string | null;
  created_by: string | null;
  owner_id: string | null;
  owner_name: string | null;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  change_url: string | null;
  try_url: string | null;
  ready_at: string | null;
  ready_token: string | null;
  /** Rises on every change to the ticket. A change sent with an older one is refused. */
  version: number;
};

export type TicketEvent = {
  id: number;
  ticket_key: string;
  actor: string;
  actor_kind: repository.ActorKind;
  type: string;
  data: unknown;
  created_at: string;
  /** For an agent's action: the connection, who issued it, its scopes and the ticket's owner. */
  context: unknown;
};

/** One entry of the conversation on a ticket, as callers see it. */
export type TicketEntry = {
  id: number;
  kind: "reply" | "note";
  body: string;
  author: string;
  author_kind: repository.ActorKind;
  author_role: "customer" | "team" | "admin";
  author_name: string;
  created_at: string;
  /** For a reply published from an internal note: that note's id. Shown to the team only. */
  based_on: number | null;
  /**
   * Notes only: what a note is for, an ordinary note, a suggested reply, or a request for
   * review. Null on a reply.
   */
  purpose: repository.NotePurpose | null;
};

/** One piece of evidence, as reported. Proofdesk verifies none of it. */
export type TicketEvidence = {
  /** The number of the test spec's scenario this evidence says it proves, if any. */
  scenario: number | null;
  id: number;
  ticket_key: string;
  kind: string;
  summary: string;
  link: string | null;
  revision: string | null;
  command: string | null;
  result: string | null;
  /** The original report, exactly as sent, or null. */
  report: unknown;
  /** For a test report Proofdesk can read: each stage as the report states it. */
  stages: {
    before_fix: StageReading;
    existing_tests: StageReading;
    after_fix: StageReading;
  } | null;
  reported_by: { id: string; kind: repository.ActorKind; name: string };
  /** Always false today: nothing is verified by Proofdesk. */
  verified_by_proofdesk: false;
  created_at: string;
};

/** What an assistant last said it needs from the team, as a label and its words. */
export type AssistantSignal = { label: "Assistant blocked:" | "Review requested by"; text: string };

/**
 * A test spec, as a person or an agent reads it: a suggestion until a person on the team
 * accepts it. Each scenario says whether any evidence names it. Proofdesk verifies none of it.
 */
export type TicketSpec = {
  id: number;
  ticket_key: string;
  state: repository.SpecState;
  summary: string;
  scenarios: (Scenario & { number: number; has_evidence: boolean })[];
  /** How many scenarios there are, and how many have evidence naming them. */
  coverage: { scenarios: number; with_evidence: number };
  proposed_by: { id: string; kind: repository.ActorKind; name: string };
  created_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  verified_by_proofdesk: false;
};

/** Most rows the service will hold. Leave a field out for no limit. */
export type Budget = {
  tickets?: number;
  entriesPerTicket?: number;
  eventsPerTicket?: number;
  evidencePerTicket?: number;
  specsPerTicket?: number;
};

/** How many tickets a list page shows. */
export const LIST_PAGE_SIZE = 100;

/** How a list may be narrowed besides its status: by owner, and by words to find. */
export type ListNarrowing = { owner?: "me" | "none"; q?: string };

/** The most entries, history events or pieces of evidence one ticket's read returns. */
export const THREAD_LIMIT = 200;

/** What a ticket page left open compares with the server, to notice a change made elsewhere. */
export type TicketStamp = { version: number; entries: number; handoffs: number };

/** What the service needs to know from outside the database: who can own a ticket, and roles. */
export type ServiceOptions = {
  teamMembers?: () => { id: string; name: string }[];
  /** Each person's role now, by id; without it, only the made-up people's roles are known. */
  peopleRoles?: (ids: string[]) => Map<string, Role>;
};

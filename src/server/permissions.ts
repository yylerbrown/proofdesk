import type { Actor } from "./actor.js";

export type Action =
  | "create"
  | "list_all"
  | "list_archived"
  | "read"
  | "edit"
  | "change_status"
  | "archive"
  | "restore"
  | "delete"
  | "reply"
  | "note"
  | "read_notes"
  | "take"
  | "release"
  | "agree_check"
  | "link_change"
  | "mark_ready"
  | "answer"
  | "manage_connections"
  | "attach_evidence"
  | "read_activity"
  | "propose_spec"
  | "decide_spec"
  | "reopen"
  | "hand_off"
  | "hand_to_agent";

/**
 * What an AI agent may be allowed to do, each named by the operation it permits. A connection
 * holds some of these. Anything not listed here is for people only.
 */
export const AGENT_SCOPES = [
  "read_tickets",
  "write_notes",
  "attach_evidence",
  "propose_specs",
  "link_changes",
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/** Which people may take an action, in plain words, and what an agent needs for it. */
export type Capability = { people: string; agent: AgentScope | "people_only" };

/**
 * The capability table: every action, who among people may take it, and the scope an agent
 * needs, or "people_only". can() below enforces it, the API's documentation shows it, and the
 * tests are generated from it. Answering "Did this fix it?", owning a ticket, asking the
 * customer, archiving, restoring and deleting stay with people, whatever an agent holds.
 */
export const CAPABILITIES: Record<Action, Capability> = {
  create: { people: "Anyone signed in.", agent: "people_only" },
  list_all: { people: "The team.", agent: "read_tickets" },
  list_archived: { people: "The team.", agent: "people_only" },
  read: { people: "The team, or the customer who filed it.", agent: "read_tickets" },
  read_notes: { people: "The team.", agent: "read_tickets" },
  edit: { people: "The team, or the customer who filed it.", agent: "people_only" },
  change_status: { people: "The ticket's owner, to start work.", agent: "people_only" },
  archive: { people: "The team, or the customer who filed it.", agent: "people_only" },
  restore: { people: "The team.", agent: "people_only" },
  delete: { people: "An admin.", agent: "people_only" },
  reply: { people: "The team, or the customer who filed it.", agent: "people_only" },
  note: { people: "The team.", agent: "write_notes" },
  take: { people: "A team member, for an unowned ticket.", agent: "people_only" },
  release: { people: "The ticket's owner, before work starts.", agent: "people_only" },
  agree_check: { people: "The team.", agent: "people_only" },
  link_change: { people: "The team.", agent: "link_changes" },
  mark_ready: { people: "The team.", agent: "people_only" },
  answer: { people: "Only the customer who filed it.", agent: "people_only" },
  manage_connections: { people: "An admin.", agent: "people_only" },
  attach_evidence: { people: "The team.", agent: "attach_evidence" },
  read_activity: { people: "The team.", agent: "people_only" },
  propose_spec: { people: "The team.", agent: "propose_specs" },
  decide_spec: { people: "The team.", agent: "people_only" },
  reopen: { people: "Only the customer who filed it.", agent: "people_only" },
  hand_off: { people: "The ticket's owner, or an admin.", agent: "people_only" },
  hand_to_agent: { people: "The ticket's owner.", agent: "people_only" },
};

/** The two facts about a ticket that permissions depend on. */
export type TicketFacts = {
  created_by: string | null;
  archived_at: string | null;
};

/**
 * The one function that answers every permission question: may this actor do this action,
 * on this ticket? Actions that are not about one ticket ("create", "list_all",
 * "list_archived") are asked without a ticket.
 *
 * - A customer works only with their own tickets and cannot change a status.
 * - A team member works with every ticket.
 * - An archived ticket is gone for customers. A team member or admin can see and restore it.
 * - Only an admin deletes a ticket permanently.
 * - A team member takes a ticket, becoming its owner, or releases it. An agent cannot own one.
 * - A team member may tighten the customer's check. The customer's words are kept beside it.
 * - A customer replies on their own tickets. Internal notes are for the team only, and a
 *   customer never sees them.
 */
// What a read-only person, the demo admin, may still do: look.
const READ_ONLY_ACTIONS: Action[] = ["list_all", "list_archived", "read", "read_notes"];

export function can(actor: Actor, action: Action, ticket?: TicketFacts): boolean {
  if (actor.readOnly === true && !READ_ONLY_ACTIONS.includes(action)) return false;
  // An agent may do only what its connection's scopes name, and never a people-only action.
  // Past this check it is held to the same rules as the team.
  if (actor.kind === "agent") {
    const needs = CAPABILITIES[action].agent;
    if (needs === "people_only" || !(actor.scopes ?? []).includes(needs)) return false;
  }
  // On the demo, tickets are never archived, restored or deleted, so one visitor cannot empty
  // the sample data for the next.
  if (
    actor.demo === true &&
    (action === "archive" || action === "restore" || action === "delete")
  ) {
    return false;
  }
  const isStaff = actor.role === "team" || actor.role === "admin";

  if (action === "create") return true;
  if (action === "list_all") return isStaff;
  if (action === "list_archived") return isStaff;
  if (action === "manage_connections") return actor.role === "admin" && actor.kind === "person";
  if (action === "read_activity") return isStaff && actor.kind === "person";

  // Every other action is about one ticket.
  if (ticket === undefined) return false;
  if (ticket.archived_at !== null && !isStaff) return false;
  const isOwn = ticket.created_by === actor.id;

  if (action === "read") return isStaff || isOwn;
  if (action === "edit") return isStaff || isOwn;
  if (action === "archive") return isStaff || isOwn;
  if (action === "change_status") return isStaff;
  if (action === "restore") return isStaff;
  if (action === "delete") return actor.role === "admin";
  if (action === "reply") return isStaff || isOwn;
  if (action === "note") return isStaff;
  if (action === "read_notes") return isStaff;
  // An owner is always a person, even when an agent does the work.
  if (action === "take") return isStaff && actor.kind === "person";
  if (action === "release") return isStaff;
  if (action === "agree_check") return isStaff;
  if (action === "link_change") return isStaff;
  if (action === "attach_evidence") return isStaff;
  // A test spec is a suggestion until a person on the team accepts it. The customer reads it.
  if (action === "propose_spec") return isStaff;
  if (action === "decide_spec") return isStaff;
  if (action === "mark_ready") return isStaff;
  // Only the person who filed the ticket answers "Did this fix it?". Not the team for them.
  if (action === "answer") return isOwn;
  if (action === "reopen") return isOwn;
  if (action === "hand_off") return isStaff && actor.kind === "person";
  if (action === "hand_to_agent") return isStaff && actor.kind === "person";
  return false;
}

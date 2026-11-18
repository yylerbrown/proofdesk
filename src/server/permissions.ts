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
  | "agree_check";

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
export function can(actor: Actor, action: Action, ticket?: TicketFacts): boolean {
  const isStaff = actor.role === "team" || actor.role === "admin";

  if (action === "create") return true;
  if (action === "list_all") return isStaff;
  if (action === "list_archived") return isStaff;

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
  return false;
}

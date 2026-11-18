import type { Actor } from "./actor.js";

export type Action =
  | "create"
  | "list_all"
  | "list_archived"
  | "read"
  | "edit"
  | "change_status"
  | "archive"
  | "restore";

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
 * - An archived ticket exists only for an admin, who alone can restore it.
 */
export function can(actor: Actor, action: Action, ticket?: TicketFacts): boolean {
  const isAdmin = actor.role === "admin";
  const isStaff = actor.role === "team" || isAdmin;

  if (action === "create") return true;
  if (action === "list_all") return isStaff;
  if (action === "list_archived") return isAdmin;

  // Every other action is about one ticket.
  if (ticket === undefined) return false;
  if (ticket.archived_at !== null && !isAdmin) return false;
  const isOwn = ticket.created_by === actor.id;

  if (action === "read") return isStaff || isOwn;
  if (action === "edit") return isStaff || isOwn;
  if (action === "archive") return isStaff || isOwn;
  if (action === "change_status") return isStaff;
  if (action === "restore") return isAdmin;
  return false;
}

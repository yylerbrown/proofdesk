import type { Actor, Role } from "./actor.js";
import { AGENT_SCOPES, CAPABILITIES, can, type Action, type TicketFacts } from "./permissions.js";

// The table on the page "Who may do what", at /roles. Every person cell starts from can(), the
// server's own permission check. can() knows nothing of who owns a ticket: the ticket service
// adds that. So a small overlay, OWNER_ACTIONS, typed by hand, says what the owner rule does to a
// cell, and tests tie it to the rules' own words and to the ticket service.

/** Each action in the words the pages and buttons use. */
export const ACTION_WORDS: Record<Action, string> = {
  create: "File a ticket",
  list_all: "See every ticket",
  list_archived: "See archived tickets",
  read: "Read a ticket",
  edit: "Edit a ticket",
  reply: "Write a reply",
  change_status: "Change the status",
  bulk_change: "Change many tickets from the list",
  archive: "Archive a ticket",
  restore: "Restore an archived ticket",
  delete: "Delete a ticket",
  agree_check: "Tighten the check",
  adopt_check: "Take the team's check as your own",
  request_suggestions: "Ask for suggested checks",
  suggest_checks: "Suggest checks on new tickets unasked",
  wait_for_requests: "Wait for a request for suggestions",
  answer_request: "Answer a request for suggestions",
  choose_check: "Choose a suggested check",
  attach_evidence: "Attach evidence",
  propose_spec: "Propose a test spec",
  decide_spec: "Accept or discard a test spec",
  link_change: "Link a code change",
  mark_ready: "Mark fixed and tell the customer",
  answer: "Say whether it is fixed",
  resolve_with_reason: "Resolve with a reason",
  reopen: "Reopen a ticket",
  take: "Take a ticket",
  release: "Release a ticket",
  hand_off: "Hand a ticket to a team member",
  hand_to_agent: "Hand a ticket to an assistant",
  note: "Write an internal note",
  read_notes: "Read internal notes",
  read_activity: "See an assistant's activity",
  list_people: "See the People page",
  change_role: "Choose who is on the team",
  manage_connections: "Issue and revoke assistant connections",
};

/** The table's groups, in order, each with its actions in order. Every action is in one. */
export const ACTION_GROUPS: { name: string; actions: Action[] }[] = [
  {
    name: "The ticket",
    actions: [
      "create",
      "list_all",
      "list_archived",
      "read",
      "edit",
      "reply",
      "change_status",
      "bulk_change",
      "archive",
      "restore",
      "delete",
    ],
  },
  {
    name: "Proving it is fixed",
    actions: [
      "agree_check",
      "adopt_check",
      "request_suggestions",
      "choose_check",
      "suggest_checks",
      "wait_for_requests",
      "answer_request",
      "attach_evidence",
      "propose_spec",
      "decide_spec",
      "link_change",
      "mark_ready",
      "answer",
      "resolve_with_reason",
      "reopen",
    ],
  },
  {
    name: "Working it",
    actions: [
      "take",
      "release",
      "hand_off",
      "hand_to_agent",
      "note",
      "read_notes",
      "read_activity",
    ],
  },
  {
    name: "People and connections",
    actions: ["list_people", "change_role", "manage_connections"],
  },
];

/**
 * The actions the ticket service limits to the ticket's owner, which can() alone does not.
 * For each, what the Team member and Admin cells read instead of "Yes". Every action whose
 * people text names an owner is here, and nothing else is: a test checks both ways.
 */
export const OWNER_ACTIONS: Partial<Record<Action, { team: string; admin: string }>> = {
  change_status: { team: "If they own it", admin: "If they own it, or back to New" },
  release: { team: "If they own it", admin: "If they own it" },
  mark_ready: { team: "If they own it", admin: "If they own it" },
  hand_to_agent: { team: "If they own it", admin: "If they own it; any admin may end it" },
  hand_off: { team: "If they own it", admin: "Owner or admin" },
  reopen: { team: "If they own it or filed it", admin: "Owner or admin" },
  resolve_with_reason: { team: "If they own it, or nobody does", admin: "Owner or admin" },
};

/** The people the cells are computed for. Never demo people: the demo refuses some actions. */
export const STAND_INS: Record<Role, Actor> = {
  customer: { id: "roles-customer", kind: "person", role: "customer", name: "A customer" },
  team: { id: "roles-team", kind: "person", role: "team", name: "A team member" },
  admin: { id: "roles-admin", kind: "person", role: "admin", name: "An admin" },
};

/** A ticket the stand-in filed, and one somebody else filed. Neither is archived. */
function ticketFiledBy(id: string): TicketFacts {
  return { created_by: id, archived_at: null };
}
const SOMEONE_ELSES: TicketFacts = ticketFiledBy("roles-someone-else");

/** May this person do it on someone else's ticket, and on their own? */
function allowed(person: Actor, action: Action): { others: boolean; own: boolean } {
  return {
    others: can(person, action, SOMEONE_ELSES),
    own: can(person, action, ticketFiledBy(person.id)),
  };
}

/** One person cell, from can() with the owner overlay applied. */
export function personCell(role: Role, action: Action): string {
  const { others, own } = allowed(STAND_INS[role], action);
  if (others) {
    const overlay = OWNER_ACTIONS[action];
    if (overlay !== undefined && role !== "customer") return overlay[role];
    return "Yes";
  }
  // For the team, "own" would read as owning the ticket, which is another rule, so it says filed.
  if (own) return role === "customer" ? "Own tickets only" : "If they filed it";
  return "No";
}

/** The assistant's cell: "Never", or the one scope it needs, in the given words. */
export function assistantCell(action: Action, scopeLabels: Record<string, string>): string {
  const needs = CAPABILITIES[action].agent;
  if (needs === "people_only") return "Never";
  // An assistant holding only that scope, as a connection is. Its role is the team's.
  const assistant: Actor = {
    id: "roles-assistant",
    kind: "agent",
    role: "team",
    name: "An assistant",
    scopes: [needs],
  };
  if (!can(assistant, action, SOMEONE_ELSES)) return "Never";
  return `With "${scopeLabels[needs]}"`;
}

export type RolesRow = {
  action: Action;
  words: string;
  people: string;
  customer: string;
  team: string;
  admin: string;
  assistant: string;
};

/** The whole table, group by group, for the page. */
export function rolesTable(
  scopeLabels: Record<(typeof AGENT_SCOPES)[number], string>,
): { name: string; rows: RolesRow[] }[] {
  return ACTION_GROUPS.map((group) => ({
    name: group.name,
    rows: group.actions.map((action) => ({
      action,
      words: ACTION_WORDS[action],
      people: CAPABILITIES[action].people,
      customer: personCell("customer", action),
      team: personCell("team", action),
      admin: personCell("admin", action),
      assistant: assistantCell(action, scopeLabels),
    })),
  }));
}

/** Which column is the viewer's, and its header words. Signed out, none is. */
export function columnHeaders(viewer: Actor | null): Record<Role, string> {
  const headers: Record<Role, string> = {
    customer: "Customer",
    team: "Team member",
    admin: "Admin",
  };
  if (viewer === null || viewer.kind !== "person") return headers;
  if (viewer.role === "admin" && viewer.readOnly === true) {
    headers.admin = "Admin (you, read-only on this demo)";
  } else {
    headers[viewer.role] = `${headers[viewer.role]} (you)`;
  }
  return headers;
}

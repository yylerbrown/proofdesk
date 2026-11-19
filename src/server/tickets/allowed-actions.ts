import type { Actor } from "../actor.js";
import { can } from "../permissions.js";
import type { Ticket } from "./types.js";

/**
 * What this actor may do to this ticket, for a page to decide which controls to show. Most
 * lines restate the owner and state rules their action checks, and are kept in step by hand.
 */
export function allowedActions(ticket: Ticket, actor: Actor) {
  const archived = ticket.archived_at !== null;
  return {
    edit: !archived && can(actor, "edit", ticket),
    archive: !archived && can(actor, "archive", ticket),
    restore: archived && can(actor, "restore", ticket),
    delete: can(actor, "delete", ticket),
    take:
      !archived &&
      can(actor, "take", ticket) &&
      ticket.owner_id === null &&
      ticket.status !== "resolved",
    release:
      !archived &&
      can(actor, "release", ticket) &&
      ticket.owner_id === actor.id &&
      ticket.status === "new",
    giveToAgent:
      !archived &&
      can(actor, "hand_to_agent", ticket) &&
      ticket.owner_id === actor.id &&
      ticket.status === "in_progress" &&
      ticket.ready_at === null,
    endAgentWork:
      !archived &&
      can(actor, "hand_to_agent", ticket) &&
      (ticket.owner_id === actor.id || actor.role === "admin"),
    handOff:
      !archived &&
      can(actor, "hand_off", ticket) &&
      ticket.status !== "resolved" &&
      (ticket.owner_id === actor.id || actor.role === "admin"),
    agreeCheck: !archived && can(actor, "agree_check", ticket),
    // A resolved ticket keeps the link it has, and the page offers no new one: a change
    // linked after resolving would never be checked by the customer.
    linkChange: !archived && can(actor, "link_change", ticket) && ticket.status !== "resolved",
    start:
      !archived &&
      can(actor, "change_status", ticket) &&
      ticket.status === "new" &&
      ticket.owner_id === actor.id,
    takeAndStart:
      !archived &&
      can(actor, "take", ticket) &&
      can(actor, "change_status", ticket) &&
      ticket.status === "new" &&
      ticket.owner_id === null,
    // The same rules as changeStatus to New.
    returnToNew:
      !archived &&
      can(actor, "change_status", ticket) &&
      ticket.status === "in_progress" &&
      (ticket.owner_id === actor.id || actor.role === "admin"),
    // The same rules as reopen.
    reopen:
      !archived &&
      can(actor, "reopen", ticket) &&
      ticket.status === "resolved" &&
      (ticket.created_by === actor.id ||
        (ticket.resolution?.by === "team" &&
          (ticket.owner_id === actor.id || actor.role === "admin"))),
    adoptCheck: !archived && can(actor, "adopt_check", ticket) && ticket.agreed_check !== null,
    attachEvidence: !archived && can(actor, "attach_evidence", ticket),
    markReady:
      !archived &&
      can(actor, "mark_ready", ticket) &&
      ticket.owner_id === actor.id &&
      ticket.status === "in_progress" &&
      ticket.ready_at === null,
    // The same rules as withdrawQuestionAsked.
    withdrawQuestion:
      !archived &&
      can(actor, "mark_ready", ticket) &&
      ticket.owner_id === actor.id &&
      ticket.ready_at !== null,
    answer: !archived && can(actor, "answer", ticket) && ticket.ready_at !== null,
    // The same rules as confirmFix: a ticket the team resolved as fixed.
    confirmFix:
      !archived &&
      can(actor, "answer", ticket) &&
      ticket.status === "resolved" &&
      ticket.resolution?.by === "team" &&
      ticket.resolution.reason === "fixed_no_reply",
    // The same rules as resolveWithReason.
    resolveWithReason:
      !archived &&
      can(actor, "resolve_with_reason", ticket) &&
      (ticket.owner_id === null || ticket.owner_id === actor.id || actor.role === "admin") &&
      ticket.status !== "resolved",
    reply: !archived && can(actor, "reply", ticket),
    note: !archived && can(actor, "note", ticket),
    decideSpec: !archived && can(actor, "decide_spec", ticket),
  };
}

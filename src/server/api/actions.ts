import { z } from "zod";
import type { Actor } from "../actor.js";
import type { Action } from "../permissions.js";
import {
  addEntrySchema,
  agreeCheckSchema,
  answerSchema,
  changeStatusSchema,
  createTicketSchema,
  giveToAgentSchema,
  handOffSchema,
  cursorFor,
  deleteTicketSchema,
  linkChangeSchema,
  listQuerySchema,
  markReadySchema,
  noteSchema,
  pageOf,
  reopenSchema,
  resolveSchema,
  verificationRequestSchema,
} from "../tickets/schemas.js";
import { addEvidenceSchema } from "../tickets/evidence.js";
import { decideSpecSchema, proposeSpecSchema } from "../tickets/spec.js";
import { LIST_PAGE_SIZE, type TicketService } from "../tickets/service.js";
import {
  deletedOutput,
  entryOutput,
  eventOutput,
  evidenceOutput,
  specOutput,
  ticketOutput,
  ticketReadOutput,
  ticketRowOutput,
} from "./schemas.js";
import { parse } from "../validation.js";

// Every action anyone can take on a ticket, in one table. The JSON API's routes are built from
// it, and each row names its permission from the capability table in permissions.ts. Each row calls the same ticket service function the pages call;
// the service decides who may do what through the one permission function, whatever door the
// request came through.

export type Method = "get" | "post" | "put" | "patch" | "delete";

type Call = {
  service: TicketService;
  actor: Actor;
  key: string;
  query: unknown;
  body: unknown;
};

export type ApiAction = {
  /** A stable name, for documentation and for tools. */
  name: string;
  method: Method;
  /** The address under /api, in Express form ("/tickets/:key"). */
  path: string;
  summary: string;
  /**
   * The permission it needs, from the capability table in permissions.ts, which says who
   * among people may call it and which agent scope it takes. The service enforces it.
   */
  needs: Action | Action[];
  query?: z.ZodObject;
  body?: z.ZodType;
  /** The status of a successful answer. */
  status?: number;
  /** What a successful answer looks like. A test checks real answers against it. */
  output: z.ZodType;
  /** True for a list that comes in pages; its doors add how to get the next page. */
  paged?: boolean;
  run: (call: Call) => unknown;
};

export const ACTIONS: ApiAction[] = [
  {
    name: "list_tickets",
    output: z.array(z.union([ticketOutput, ticketRowOutput])),
    method: "get",
    path: "/tickets",
    summary:
      "List tickets: open ones newest first, then resolved ones. A customer sees only their own. An assistant gets a short row per ticket handed to it; get_ticket reads one in full.",
    needs: "read",
    query: listQuerySchema,
    paged: true,
    run: ({ service, actor, query }) => {
      const { status, page, cursor, owner, q } = parse(listQuerySchema, query);
      const tickets = service.listTickets(
        status ?? "all",
        actor,
        cursor ? pageOf(cursor) : (page ?? 1),
        { owner, q },
      );
      if (actor.kind !== "agent") return tickets;
      return tickets.map((ticket) => ({
        key: ticket.key,
        title: ticket.title,
        status: ticket.status,
        waiting_on: ticket.waiting_on,
        owner_name: ticket.owner_name,
        customer_check: ticket.done_when.customer_check,
        resolution_label: ticket.resolution?.label ?? null,
        updated_at: ticket.updated_at,
      }));
    },
  },
  {
    name: "create_ticket",
    output: ticketOutput,
    method: "post",
    path: "/tickets",
    summary: "File a ticket. fix_check says how the customer will know it is fixed.",
    needs: "create",
    body: createTicketSchema,
    status: 201,
    run: ({ service, actor, body }) => service.createTicket(body, actor),
  },
  {
    name: "get_ticket",
    output: ticketReadOutput,
    method: "get",
    path: "/tickets/:key",
    summary:
      "One ticket, led by done_when: what the customer will accept as fixed. spec is its test " +
      "spec, or null when it has none yet; then you may offer one with propose_spec.",
    needs: "read",
    run: ({ service, actor, key }) => ({
      ...service.getTicket(key, actor),
      spec: service.getSpec(key, actor),
    }),
  },
  {
    name: "change_status",
    output: ticketOutput,
    method: "patch",
    path: "/tickets/:key",
    summary:
      "Start work: move a New ticket you own to in_progress. Nothing else moves the status this way: the customer's Yes resolves (or the team resolves with a reason, resolve_with_reason), and a resolved ticket moves only by reopen.",
    needs: "change_status",
    body: changeStatusSchema,
    run: ({ service, actor, key, body }) => service.changeStatus(key, body, actor),
  },
  {
    name: "edit_ticket",
    output: ticketOutput,
    method: "put",
    path: "/tickets/:key",
    summary: "Replace the text of a ticket.",
    needs: "edit",
    body: createTicketSchema,
    run: ({ service, actor, key, body }) => service.editTicket(key, body, actor),
  },
  {
    name: "agree_check",
    output: ticketOutput,
    method: "put",
    path: "/tickets/:key/agreed-check",
    summary:
      "Set the team's interpretation of the customer's check. Empty removes it. The customer's own words never change.",
    needs: "agree_check",
    body: agreeCheckSchema,
    run: ({ service, actor, key, body }) => service.agreeCheck(key, body, actor),
  },
  {
    name: "adopt_check",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/adopt-check",
    summary:
      "The customer adopts the team's interpretation as their own check, in those exact words.",
    needs: "adopt_check",
    run: ({ service, actor, key }) => service.adoptCheck(key, actor),
  },
  {
    name: "link_change",
    output: ticketOutput,
    method: "put",
    path: "/tickets/:key/change-link",
    summary: "Link the code change that should fix the ticket.",
    needs: "link_change",
    body: linkChangeSchema,
    run: ({ service, actor, key, body }) => service.linkChange(key, body, actor),
  },
  {
    name: "mark_ready",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/ready",
    summary:
      'Ask the customer "Did this fix it?". The ticket must be in progress, and only its owner asks. Every field is optional, and the customer sees each one given: try_url (a page on the live site to try), tried, result, response (what changed since their last No) and evidence_ids.',
    needs: "mark_ready",
    body: markReadySchema,
    run: ({ service, actor, key, body }) => service.markReady(key, body, actor),
  },
  {
    name: "withdraw_question",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/withdraw-question",
    summary: "The owner takes back the question the customer has not answered yet.",
    needs: "mark_ready",
    run: ({ service, actor, key }) => service.withdrawQuestionAsked(key, actor),
  },
  {
    name: "answer",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/answer",
    summary:
      'The customer answers "Did this fix it?". Yes resolves the ticket; no needs a comment.',
    needs: "answer",
    body: answerSchema,
    run: ({ service, actor, key, body }) => service.answer(key, body, actor),
  },
  {
    name: "take_ticket",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/take",
    summary: "Become the named owner of an unowned ticket.",
    needs: "take",
    run: ({ service, actor, key }) => service.takeTicket(key, actor),
  },
  {
    name: "take_and_start",
    method: "post",
    path: "/tickets/:key/take-and-start",
    summary: "Take an unowned New ticket and start work on it, in one step.",
    needs: ["take", "change_status"],
    output: ticketOutput,
    run: ({ service, actor, key }) => service.takeAndStart(key, actor),
  },
  {
    name: "reopen",
    method: "post",
    path: "/tickets/:key/reopen",
    summary:
      "Reopen a resolved ticket, with a reason. The customer who filed it can, after their own Yes or the team's resolution. The ticket's owner or an admin can reopen one the team resolved, never one the customer confirmed. Never an agent. It goes back to its owner, in progress, or to the inbox if it has none.",
    needs: "reopen",
    body: reopenSchema,
    output: ticketOutput,
    run: ({ service, actor, key, body }) => service.reopen(key, body, actor),
  },
  {
    name: "resolve_with_reason",
    method: "post",
    path: "/tickets/:key/resolve",
    summary:
      "Resolve a New or In Progress ticket without the customer's Yes, with a reason: fixed_no_reply, duplicate (with duplicate_of), wont_fix, cannot_reproduce, or other (with a note). The ticket's owner or an admin, or a team member for a ticket nobody owns yet, who becomes its owner; never an agent. It shows as resolved by the team, apart from Customer confirmed. The customer can reopen it, and so can its owner or an admin.",
    needs: "resolve_with_reason",
    body: resolveSchema,
    output: ticketOutput,
    run: ({ service, actor, key, body }) => service.resolveWithReason(key, body, actor),
  },
  {
    name: "hand_off",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/hand-off",
    summary:
      "The owner, or an admin, hands the ticket to another team member. expected_owner must be the current owner.",
    needs: "hand_off",
    body: handOffSchema,
    run: ({ service, actor, key, body }) => service.handOff(key, body, actor),
  },
  {
    name: "give_to_agent",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/agent",
    summary:
      "The owner hands an in-progress ticket to one agent connection, which can then work on that ticket only.",
    needs: "hand_to_agent",
    body: giveToAgentSchema,
    run: ({ service, actor, key, body }) => service.giveToAgent(key, body, actor),
  },
  {
    name: "end_agent_work",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/agent/end",
    summary: "The owner, or an admin, ends the agent's work on the ticket.",
    needs: "hand_to_agent",
    run: ({ service, actor, key }) => service.endAgentWork(key, actor),
  },
  {
    name: "release_ticket",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/release",
    summary: "The owner lets go of a New ticket, back to the inbox.",
    needs: "release",
    run: ({ service, actor, key }) => service.releaseTicket(key, actor),
  },
  {
    name: "archive_ticket",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/archive",
    summary: "Hide the ticket from the lists. Nothing is deleted.",
    needs: "archive",
    run: ({ service, actor, key }) => service.archiveTicket(key, actor),
  },
  {
    name: "restore_ticket",
    output: ticketOutput,
    method: "post",
    path: "/tickets/:key/restore",
    summary: "Bring an archived ticket back.",
    needs: "restore",
    run: ({ service, actor, key }) => service.restoreTicket(key, actor),
  },
  {
    name: "delete_ticket",
    output: deletedOutput,
    method: "delete",
    path: "/tickets/:key",
    summary: "Delete the ticket permanently. The body must repeat the key.",
    needs: "delete",
    body: deleteTicketSchema,
    run: ({ service, actor, key, body }) => {
      const { filesCleaned } = service.deleteTicket(key, body, actor);
      return { deleted: true, files_cleaned: filesCleaned };
    },
  },
  {
    name: "list_entries",
    output: z.array(entryOutput),
    method: "get",
    path: "/tickets/:key/entries",
    summary: "The conversation. A customer never sees internal notes.",
    needs: "read",
    run: ({ service, actor, key }) => service.listEntries(key, actor),
  },
  {
    name: "add_entry",
    output: entryOutput,
    method: "post",
    path: "/tickets/:key/entries",
    summary: "Add a reply the customer sees, or an internal note for the team.",
    needs: ["reply", "note"],
    body: addEntrySchema,
    status: 201,
    run: ({ service, actor, key, body }) => service.addEntry(key, body, actor),
  },
  {
    name: "add_note",
    output: entryOutput,
    method: "post",
    path: "/tickets/:key/notes",
    summary:
      "Add an internal note for the team. The customer never sees it. Wording you suggest for the customer goes here with suggested_reply: true; a person decides whether to publish it. Send blocked: true when you are blocked, saying what blocks you in the first line.",
    needs: "note",
    body: noteSchema,
    status: 201,
    run: ({ service, actor, key, body }) => service.addNote(key, body, actor),
  },
  {
    name: "list_evidence",
    output: z.array(evidenceOutput),
    method: "get",
    path: "/tickets/:key/evidence",
    summary: "The evidence attached to a ticket, as reported. Proofdesk verifies none of it.",
    needs: "read",
    run: ({ service, actor, key }) => service.listEvidence(key, actor),
  },
  {
    name: "add_evidence",
    output: evidenceOutput,
    method: "post",
    path: "/tickets/:key/evidence",
    summary: "Attach evidence that the check was met. It never resolves the ticket.",
    needs: "attach_evidence",
    body: addEvidenceSchema,
    status: 201,
    run: ({ service, actor, key, body }) => service.addEvidence(key, body, actor),
  },
  {
    name: "propose_spec",
    output: specOutput,
    method: "post",
    path: "/tickets/:key/spec",
    summary:
      "Propose a test spec for a ticket: a one-paragraph summary a customer can read, and " +
      "scenarios, each given / when / then in plain words, that make the customer's check " +
      "testable. Do not invent requirements the customer did not ask for. It replaces the " +
      "ticket's current spec, and stays a suggestion until a person on the team accepts it. " +
      "Evidence can then name the scenario it proves. It never changes the ticket's status.",
    needs: "propose_spec",
    body: proposeSpecSchema,
    status: 201,
    run: ({ service, actor, key, body }) => service.proposeSpec(key, body, actor),
  },
  {
    name: "decide_spec",
    output: specOutput,
    method: "post",
    path: "/tickets/:key/spec/decision",
    summary:
      'Accept the proposed test spec as the agreed way to test, or discard it: { "decision": "accept" } or "discard".',
    needs: "decide_spec",
    body: decideSpecSchema,
    run: ({ service, actor, key, body }) => service.decideSpec(key, body, actor),
  },
  {
    name: "ask_owner_to_review",
    output: entryOutput,
    method: "post",
    path: "/tickets/:key/owner-review",
    summary:
      "Ask the ticket owner to review your evidence. This does not contact the customer: it is written as an internal note, the owner decides whether to ask the customer, and only the customer answers.",
    needs: "note",
    body: verificationRequestSchema,
    status: 201,
    run: ({ service, actor, key, body }) => service.askOwnerToReview(key, body, actor),
  },
  {
    name: "list_events",
    output: z.array(eventOutput),
    method: "get",
    path: "/tickets/:key/events",
    summary: "The ticket's history: who did what, and whether they are a person or an agent.",
    needs: "read",
    run: ({ service, actor, key }) => service.listEvents(key, actor),
  },
];

/**
 * The cursor for the page after this one, or null when this page is the last. A full page
 * means there may be more.
 */
export function nextCursor(query: unknown, items: unknown[]): string | null {
  if (items.length < LIST_PAGE_SIZE) return null;
  const { page, cursor } = parse(listQuerySchema, query);
  return cursorFor((cursor ? pageOf(cursor) : (page ?? 1)) + 1);
}

/** "/tickets/:key" in the form the documentation uses: "/tickets/{key}". */
export function documentedPath(path: string): string {
  return path.replace(/:([a-z]+)/g, "{$1}");
}

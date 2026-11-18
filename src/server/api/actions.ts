import type { z } from "zod";
import type { Actor } from "../actor.js";
import type { Action } from "../permissions.js";
import {
  addEntrySchema,
  agreeCheckSchema,
  answerSchema,
  changeStatusSchema,
  createTicketSchema,
  deleteTicketSchema,
  linkChangeSchema,
  listQuerySchema,
  markReadySchema,
} from "../tickets/schemas.js";
import { addEvidenceSchema } from "../tickets/evidence.js";
import type { TicketService } from "../tickets/service.js";
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
  /** The page form that does the same thing, if there is one. */
  page?: string;
  run: (call: Call) => unknown;
};

export const ACTIONS: ApiAction[] = [
  {
    name: "list_tickets",
    method: "get",
    path: "/tickets",
    summary:
      "List tickets: open ones newest first, then resolved ones. A customer sees only their own.",
    needs: "read",
    query: listQuerySchema,
    run: ({ service, actor, query }) => {
      const { status, page } = parse(listQuerySchema, query);
      return service.listTickets(status ?? "all", actor, page ?? 1);
    },
  },
  {
    name: "create_ticket",
    method: "post",
    path: "/tickets",
    summary: "File a ticket. fix_check says how the customer will know it is fixed.",
    needs: "create",
    body: createTicketSchema,
    status: 201,
    page: "POST /tickets",
    run: ({ service, actor, body }) => service.createTicket(body, actor),
  },
  {
    name: "get_ticket",
    method: "get",
    path: "/tickets/:key",
    summary: "One ticket.",
    needs: "read",
    run: ({ service, actor, key }) => service.getTicket(key, actor),
  },
  {
    name: "change_status",
    method: "patch",
    path: "/tickets/:key",
    summary:
      "Change the status to new or in_progress. In progress needs an owner. Only the customer's yes resolves.",
    needs: "change_status",
    body: changeStatusSchema,
    page: "POST /tickets/:key/status",
    run: ({ service, actor, key, body }) => service.changeStatus(key, body, actor),
  },
  {
    name: "edit_ticket",
    method: "put",
    path: "/tickets/:key",
    summary: "Replace the text of a ticket.",
    needs: "edit",
    body: createTicketSchema,
    page: "POST /tickets/:key/edit",
    run: ({ service, actor, key, body }) => service.editTicket(key, body, actor),
  },
  {
    name: "agree_check",
    method: "put",
    path: "/tickets/:key/agreed-check",
    summary: "Set the agreed version of the customer's check. Empty removes it.",
    needs: "agree_check",
    body: agreeCheckSchema,
    page: "POST /tickets/:key/agreed-check",
    run: ({ service, actor, key, body }) => service.agreeCheck(key, body, actor),
  },
  {
    name: "link_change",
    method: "put",
    path: "/tickets/:key/change-link",
    summary: "Link the code change that should fix the ticket.",
    needs: "link_change",
    body: linkChangeSchema,
    page: "POST /tickets/:key/change-link",
    run: ({ service, actor, key, body }) => service.linkChange(key, body, actor),
  },
  {
    name: "mark_ready",
    method: "post",
    path: "/tickets/:key/ready",
    summary: 'Ask the customer "Did this fix it?", with a page on the live site to try.',
    needs: "mark_ready",
    body: markReadySchema,
    page: "POST /tickets/:key/ready",
    run: ({ service, actor, key, body }) => service.markReady(key, body, actor),
  },
  {
    name: "answer",
    method: "post",
    path: "/tickets/:key/answer",
    summary:
      'The customer answers "Did this fix it?". Yes resolves the ticket; no needs a comment.',
    needs: "answer",
    body: answerSchema,
    page: "POST /tickets/:key/answer",
    run: ({ service, actor, key, body }) => service.answer(key, body, actor),
  },
  {
    name: "take_ticket",
    method: "post",
    path: "/tickets/:key/take",
    summary: "Become the ticket's named owner.",
    needs: "take",
    page: "POST /tickets/:key/take",
    run: ({ service, actor, key }) => service.takeTicket(key, actor),
  },
  {
    name: "release_ticket",
    method: "post",
    path: "/tickets/:key/release",
    summary: "Leave the ticket without an owner. Not while it is in progress.",
    needs: "release",
    page: "POST /tickets/:key/release",
    run: ({ service, actor, key }) => service.releaseTicket(key, actor),
  },
  {
    name: "archive_ticket",
    method: "post",
    path: "/tickets/:key/archive",
    summary: "Hide the ticket from the lists. Nothing is deleted.",
    needs: "archive",
    page: "POST /tickets/:key/archive",
    run: ({ service, actor, key }) => service.archiveTicket(key, actor),
  },
  {
    name: "restore_ticket",
    method: "post",
    path: "/tickets/:key/restore",
    summary: "Bring an archived ticket back.",
    needs: "restore",
    page: "POST /tickets/:key/restore",
    run: ({ service, actor, key }) => service.restoreTicket(key, actor),
  },
  {
    name: "delete_ticket",
    method: "delete",
    path: "/tickets/:key",
    summary: "Delete the ticket permanently. The body must repeat the key.",
    needs: "delete",
    body: deleteTicketSchema,
    page: "POST /tickets/:key/delete",
    run: ({ service, actor, key, body }) => {
      const { filesCleaned } = service.deleteTicket(key, body, actor);
      return { deleted: true, files_cleaned: filesCleaned };
    },
  },
  {
    name: "list_entries",
    method: "get",
    path: "/tickets/:key/entries",
    summary: "The conversation. A customer never sees internal notes.",
    needs: "read",
    run: ({ service, actor, key }) => service.listEntries(key, actor),
  },
  {
    name: "add_entry",
    method: "post",
    path: "/tickets/:key/entries",
    summary: "Add a reply the customer sees, or an internal note for the team.",
    needs: ["reply", "note"],
    body: addEntrySchema,
    status: 201,
    page: "POST /tickets/:key/entries",
    run: ({ service, actor, key, body }) => service.addEntry(key, body, actor),
  },
  {
    name: "list_evidence",
    method: "get",
    path: "/tickets/:key/evidence",
    summary: "The evidence attached to a ticket, as reported. Proofdesk verifies none of it.",
    needs: "read",
    run: ({ service, actor, key }) => service.listEvidence(key, actor),
  },
  {
    name: "add_evidence",
    method: "post",
    path: "/tickets/:key/evidence",
    summary: "Attach evidence that the check was met. It never resolves the ticket.",
    needs: "attach_evidence",
    body: addEvidenceSchema,
    status: 201,
    run: ({ service, actor, key, body }) => service.addEvidence(key, body, actor),
  },
  {
    name: "list_events",
    method: "get",
    path: "/tickets/:key/events",
    summary: "The ticket's history: who did what, and whether they are a person or an agent.",
    needs: "read",
    run: ({ service, actor, key }) => service.listEvents(key, actor),
  },
];

/** "/tickets/:key" in the form the documentation uses: "/tickets/{key}". */
export function documentedPath(path: string): string {
  return path.replace(/:([a-z]+)/g, "{$1}");
}

import { DEMO_ACTORS, DEV_ACTORS, type Actor, type Role } from "../actor.js";
import { DEMO_SEED_PEOPLE, requireDemoSeed } from "../demo.js";
import { HttpError } from "../errors.js";
import { can } from "../permissions.js";
import { isDemoAgent, narrowed } from "./access.js";
import { requirePermission } from "./checks.js";
import { parseKey } from "./keys.js";
import * as repository from "./repository.js";
import type { ListSort, TicketListFilter, TicketStatus } from "./schemas.js";
import type { Shared } from "./shared.js";
import {
  LIST_PAGE_SIZE,
  THREAD_LIMIT,
  type ListNarrowing,
  type ServiceOptions,
  type Ticket,
  type TicketEvent,
  type TicketStamp,
} from "./types.js";

// The list and the reads of one ticket: what a viewer may see, and the names and roles a page
// shows beside it. None of these write.

const ARCHIVED: repository.ListScope = { kind: "archived" };

// The kinds of history entry a customer may see. Any other kind, including one added later,
// stays hidden from customers until it is added here on purpose. "note_added" is left out.
const CUSTOMER_EVENT_TYPES = new Set([
  "created",
  "status_changed",
  "edited",
  "owner_changed",
  "check_agreed",
  "reply_added",
  "change_linked",
  "ready_for_customer",
  "question_withdrawn",
  "customer_answered",
  "reopened",
  "reopened_by_team",
  "check_adopted",
  "resolved_by_team",
  "evidence_added",
  "spec_accepted",
  "spec_discarded",
  "archived",
  "restored",
]);

export function createReads(shared: Shared, options: ServiceOptions) {
  const { db, prefix, requireRow, visibleScope, toTicket, toEvent } = shared;

  return {
    /**
     * One page of the list. A team member or admin gets every ticket, an assistant only its
     * own, and a customer only the ones they filed. "archived" lists only archived tickets, for
     * a team member or admin. Every other filter leaves archived tickets out.
     */
    listTickets(
      filter: TicketListFilter,
      actor: Actor,
      pageNumber = 1,
      narrowing: ListNarrowing = {},
      sort: ListSort = "open_first",
    ): Ticket[] {
      const page = { limit: LIST_PAGE_SIZE, offset: (pageNumber - 1) * LIST_PAGE_SIZE };
      if (filter === "archived") requirePermission(actor, "list_archived");
      const scope = filter === "archived" ? ARCHIVED : visibleScope(actor);
      const status = filter === "all" || filter === "archived" ? null : filter;
      const rows = repository.listTickets(
        db,
        scope,
        status,
        sort,
        page,
        narrowed(narrowing, actor),
      );
      return rows.map((row) => toTicket(row, actor));
    },

    /**
     * How many tickets of each status this viewer's list holds with the same owner filter and
     * search: the counts beside the status filters. They come from the same scope as the list,
     * so a customer's counts cover only their own tickets.
     */
    countTickets(actor: Actor, narrowing: ListNarrowing = {}): Record<TicketStatus, number> {
      return repository.countTicketsByStatus(db, visibleScope(actor), narrowed(narrowing, actor));
    },

    /**
     * The ticket key this text names, such as "sup-3" for SUP-3, when this viewer may open that
     * ticket; otherwise null. Someone else's ticket gives null, exactly as a key that does not
     * exist, so the answer says nothing about tickets the viewer cannot see.
     */
    visibleKey(text: string, actor: Actor): string | null {
      const typed = text.trim();
      const start = `${prefix}-`;
      if (typed.slice(0, start.length).toUpperCase() !== start.toUpperCase()) return null;
      const key = start + typed.slice(start.length);
      if (parseKey(prefix, key) === null) return null;
      try {
        requireRow(key, actor);
        return key;
      } catch (err) {
        if (err instanceof HttpError) return null;
        throw err;
      }
    },

    getTicket(key: string, actor: Actor): Ticket {
      return toTicket(requireRow(key, actor), actor);
    },

    /**
     * A cheap read for a ticket page left open: the ticket's version, how many entries of its
     * conversation this viewer sees, and how often an assistant was given the ticket or stopped
     * working on it. Who may read it is checked exactly as for the ticket.
     */
    ticketStamp(key: string, actor: Actor): TicketStamp {
      const row = requireRow(key, actor);
      const team = can(actor, "read_notes", row);
      return {
        version: row.version,
        // The page shows at most THREAD_LIMIT of them, so it counts no further.
        entries: Math.min(repository.countEntries(db, row.id, team), THREAD_LIMIT),
        // A hand to an assistant is team-only work, so a customer's count stays at 0.
        handoffs: team ? repository.countHandoffChanges(db, row.id) : 0,
      };
    },

    /** The history, oldest first. Someone who may not read notes does not see them added. */
    listEvents(key: string, actor: Actor): TicketEvent[] {
      const row = requireRow(key, actor);
      let events = repository.listEvents(db, row.id, THREAD_LIMIT).map(toEvent);
      if (isDemoAgent(actor)) {
        const seeded = requireDemoSeed(db).events;
        events = events.filter((event) => seeded.includes(event.id) || event.actor === actor.id);
      }
      if (can(actor, "read_notes", row)) return events;
      // The connection details an agent's entry records are for the team.
      return events
        .filter((event) => CUSTOMER_EVENT_TYPES.has(event.type))
        .map((event) => ({ ...event, context: null }));
    },

    /**
     * The keys of the open tickets, of these, that their customer reopened and that nobody has
     * asked the customer about since, so the team's list can say why each one is back.
     */
    reopenedByCustomer(tickets: Ticket[]): Set<string> {
      const keyOf = new Map<number, string>();
      for (const ticket of tickets) {
        const id = parseKey(prefix, ticket.key);
        if (ticket.waiting_on === "team" && id !== null) keyOf.set(id, ticket.key);
      }
      const keys = new Set<string>();
      for (const id of repository.reopenedByCustomer(db, [...keyOf.keys()])) {
        keys.add(keyOf.get(id)!);
      }
      return keys;
    },

    /** Each person's role now, to show beside a name read live. */
    peopleRoles(ids: string[]): Map<string, Role> {
      if (options.peopleRoles) return options.peopleRoles(ids);
      const roles = new Map<string, Role>();
      for (const person of [...DEV_ACTORS, ...DEMO_ACTORS, ...DEMO_SEED_PEOPLE]) {
        if (ids.includes(person.id)) roles.set(person.id, person.role);
      }
      return roles;
    },

    /**
     * The display name for each id that wrote history: a GitHub name, or one of the made-up
     * people of the entrance. An id that is neither, such as the "anonymous" of the first
     * tickets, is not in the map.
     */
    peopleNames(ids: string[]): Map<string, string> {
      const names = repository.userNames(db, ids);
      // The made-up people, and those the demo's samples name, are not in the sign-in tables.
      for (const person of [...DEV_ACTORS, ...DEMO_ACTORS, ...DEMO_SEED_PEOPLE]) {
        if (ids.includes(person.id)) names.set(person.id, person.name);
      }
      // An assistant's entry names its connection only for the team, so anyone else reads it
      // as the team's assistant.
      for (const id of ids) {
        if (id.startsWith("connection-")) names.set(id, "The team's assistant");
      }
      // A change the server settings made, such as ending an assistant's work when its issuer
      // stopped being an admin there.
      if (ids.includes("server-settings")) names.set("server-settings", "The server settings");
      return names;
    },

    /** True when there are no tickets at all, archived ones included. */
    hasNoTickets(): boolean {
      return repository.countTickets(db) === 0;
    },
  };
}

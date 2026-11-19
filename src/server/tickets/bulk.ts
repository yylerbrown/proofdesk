import { z } from "zod";
import type { Actor } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { parse } from "../validation.js";
import { requirePermission } from "./checks.js";
import { readResolveInput } from "./resolve-and-reopen.js";
import { RESOLVE_REASONS, TICKET_STATUSES, type TicketStatus } from "./schemas.js";
import { LIST_PAGE_SIZE, type Ticket } from "./types.js";

// One change made to many tickets at once, from the ticket list: a new status, or a new owner.
// Nothing here is a rule of its own. Each ticket goes through the same service function as the
// same change made on its own page (take, start, return to New, resolve with a reason, hand off,
// release), so it is refused for the same reasons, writes its own history and sends the same
// email notices. A bulk change carries no versions: it acts on each ticket as it is now.

// A form sends one ticked box as a text, and several as a list.
const oneOrMany = (value: unknown) => (typeof value === "string" ? [value] : value);
// A form sends an empty box for a choice left blank; that means it was not given.
const blankIsMissing = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

export const bulkChangeSchema = z.object({
  keys: z
    .preprocess(
      oneOrMany,
      z
        .array(z.string().trim().min(1).max(20), { error: "Tick at least one ticket." })
        .min(1, "Tick at least one ticket.")
        .max(LIST_PAGE_SIZE, `Change at most ${LIST_PAGE_SIZE} tickets at once.`),
    )
    .meta({ description: `The tickets to change, by key, at most ${LIST_PAGE_SIZE}.` }),
  status: z
    .preprocess(blankIsMissing, z.enum(TICKET_STATUSES).optional())
    .meta({ description: "The new status. Send status or owner, not both." }),
  owner: z.preprocess(blankIsMissing, z.string().trim().max(200).optional()).meta({
    description: 'The new owner: "me", "nobody", or a team member\'s id. Send status or owner.',
  }),
  reason: z
    .preprocess(blankIsMissing, z.enum(RESOLVE_REASONS).optional())
    .meta({ description: "For status resolved: why, as for resolve_with_reason." }),
  note: z
    .preprocess(blankIsMissing, z.string().max(500).optional())
    .meta({ description: "For reason other: the note." }),
  duplicate_of: z
    .preprocess(blankIsMissing, z.string().max(20).optional())
    .meta({ description: "For reason duplicate: the other ticket's key." }),
});

/** The change asked for, once checked. */
type StatusChange = {
  status: TicketStatus;
  reason?: (typeof RESOLVE_REASONS)[number];
  note?: string;
  duplicate_of?: string;
};
type OwnerChange = { owner: string };
export type BulkChange = StatusChange | OwnerChange;

/** A ticket that was not changed, and why: the same status and words as the single change. */
export type NotChanged = { key: string; status: number; code: string; message: string };

export type BulkOutcome = { change: BulkChange; changed: string[]; not_changed: NotChanged[] };

/** The service functions a bulk change calls, one ticket at a time. */
type TicketActions = {
  getTicket(key: string, actor: Actor): Ticket;
  changeStatus(key: string, input: unknown, actor: Actor): Ticket;
  takeAndStart(key: string, actor: Actor, input?: unknown): Ticket;
  takeTicket(key: string, actor: Actor, input?: unknown): Ticket;
  releaseTicket(key: string, actor: Actor, input?: unknown): Ticket;
  handOff(key: string, input: unknown, actor: Actor): Ticket;
  resolveWithReason(key: string, input: unknown, actor: Actor): Ticket;
};

const STATUS_WORDS: Record<TicketStatus, string> = {
  new: "New",
  in_progress: "In Progress",
  resolved: "Resolved",
};

/** Raised for a ticket that already is what was asked, so nothing is written. */
class NothingToChange extends HttpError {
  constructor(message: string) {
    super(200, "nothing_to_change", message);
  }
}

export function createBulk(
  actions: TicketActions,
  teamMembers: () => { id: string; name: string }[],
) {
  /** Reads and checks the change asked for, before any ticket is touched. */
  function readChange(input: unknown, actor: Actor): { keys: string[]; change: BulkChange } {
    const { keys, status, owner, reason, note, duplicate_of } = parse(bulkChangeSchema, input);
    if ((status === undefined) === (owner === undefined)) {
      throw new ValidationError("Choose a status or an owner.", {
        status: ["Choose a status or an owner."],
      });
    }
    // The same key ticked twice is changed once, however its letters are written.
    const unique = [...new Set(keys.map((key) => key.toUpperCase()))];
    if (status === "resolved") {
      // One reason for all of them, checked as the resolve form on a ticket checks it.
      const resolve = readResolveInput({ reason, note, duplicate_of });
      return { keys: unique, change: { status, ...withoutBlanks(resolve) } };
    }
    if (status !== undefined) return { keys: unique, change: { status } };
    const chosen = owner!;
    const isMember = teamMembers().some((member) => member.id === chosen);
    if (chosen !== "me" && chosen !== "nobody" && !isMember) {
      throw new ValidationError("Choose a team member.", { owner: ["Choose a team member."] });
    }
    // Choosing yourself by name is the same as choosing "me".
    return { keys: unique, change: { owner: chosen === actor.id ? "me" : chosen } };
  }

  /** Moves one ticket to a status, by the same step its own page would use. */
  function moveTo(before: Ticket, change: StatusChange, actor: Actor) {
    const { key } = before;
    if (change.status === "resolved") {
      return actions.resolveWithReason(
        key,
        { reason: change.reason, note: change.note, duplicate_of: change.duplicate_of },
        actor,
      );
    }
    // An unowned New ticket is taken and started in one step, as its page offers.
    if (change.status === "in_progress" && before.status === "new" && before.owner_id === null) {
      return actions.takeAndStart(key, actor);
    }
    return actions.changeStatus(key, { status: change.status }, actor);
  }

  /** Gives one ticket a new owner, or none, by the same step its own page would use. */
  function assign(before: Ticket, owner: string, actor: Actor) {
    const { key } = before;
    if (owner === "nobody") {
      if (before.owner_id === null) throw new NothingToChange(`Nobody owns ${key} already.`);
      return actions.releaseTicket(key, actor);
    }
    const to = owner === "me" ? actor.id : owner;
    if (before.owner_id === to) {
      throw new NothingToChange(
        owner === "me"
          ? `${key} is yours already.`
          : `${before.owner_name ?? "That person"} owns ${key} already.`,
      );
    }
    if (before.owner_id === null && to === actor.id) return actions.takeTicket(key, actor);
    return actions.handOff(key, { to, expected_owner: before.owner_id ?? "" }, actor);
  }

  return {
    /**
     * Checks a change as changeTickets would, and touches no ticket. The list's one Apply can
     * send two changes, and checks both before it makes either.
     */
    checkChange(input: unknown, actor: Actor): void {
      requirePermission(actor, "bulk_change");
      readChange(input, actor);
    },

    /**
     * Makes one change to each ticket named, at most one page of the list. The team only; an
     * assistant connection never. Each ticket is changed, or left as it is with the reason the
     * same change on its own page would give. One ticket's refusal never stops the others.
     */
    changeTickets(input: unknown, actor: Actor): BulkOutcome {
      requirePermission(actor, "bulk_change");
      const { keys, change } = readChange(input, actor);
      const changed: string[] = [];
      const notChanged: NotChanged[] = [];
      for (const asked of keys) {
        let key = asked;
        try {
          const before = actions.getTicket(asked, actor);
          key = before.key;
          const after =
            "status" in change
              ? moveTo(before, change, actor)
              : assign(before, change.owner, actor);
          // A step asked for what is already true, so it wrote nothing, as on the ticket's page.
          if (after.version === before.version) throw new NothingToChange(already(before, change));
          changed.push(key);
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          notChanged.push({ key, status: err.status, code: err.code, message: err.message });
        }
      }
      return { change, changed, not_changed: notChanged };
    },
  };
}

/** What is already true of a ticket that a change left as it was. */
function already(before: Ticket, change: BulkChange): string {
  if ("status" in change) return `${before.key} is ${STATUS_WORDS[change.status]} already.`;
  return `${before.key} is yours already.`;
}

/** The resolve fields that were given, so the answer does not carry empty ones. */
function withoutBlanks(fields: ReturnType<typeof readResolveInput>) {
  const { reason, note, duplicate_of } = fields;
  return {
    reason,
    ...(note ? { note } : {}),
    ...(duplicate_of ? { duplicate_of } : {}),
  };
}

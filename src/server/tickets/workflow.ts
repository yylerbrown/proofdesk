import type { Actor } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { parse } from "../validation.js";
import { requireNotArchived, requirePermission, requireVersion, saved } from "./checks.js";
import { noQuestion } from "./history.js";
import * as repository from "./repository.js";
import { changeStatusSchema, handOffSchema, versionOnlySchema } from "./schemas.js";
import type { Shared } from "./shared.js";
import type { Ticket } from "./types.js";

// The status workflow and who owns a ticket: take it, start work, release it, send it back to
// New, and hand it to another team member. Resolving and reopening are in resolve-and-reopen.ts.

/** The answer to anyone who tries to resolve a ticket by changing its status. */
function needsCustomer(key: string): HttpError {
  return new HttpError(
    409,
    "needs_customer",
    `A status change does not resolve ticket ${key}. "Mark fixed and tell the customer" resolves it as fixed at once and tells the customer. To ask the customer "Did this fix it?" first, use "Ask before resolving" under More options; the team can also resolve it with a reason.`,
  );
}

/** Only the ticket's own owner starts work on it, and only once it has one. */
function requireOwnerStarts(key: string, row: repository.TicketRow, actor: Actor): void {
  if (row.owner_id === null) {
    throw new HttpError(409, "needs_owner", `Take ticket ${key} before moving it to In Progress.`);
  }
  if (row.owner_id !== actor.id) {
    throw new HttpError(
      403,
      "not_owner",
      `Only ${row.owner_name ?? "its owner"}, who owns ticket ${key}, starts work on it.`,
    );
  }
}

/** Only the ticket's owner, or an admin, sends a ticket back to New. */
function requireOwnerOrAdminReturns(key: string, row: repository.TicketRow, actor: Actor): void {
  if (row.owner_id === actor.id || actor.role === "admin") return;
  throw new HttpError(
    403,
    "not_owner",
    `Only ${row.owner_name ?? "its owner"}, who owns ticket ${key}, or an admin can return it to New.`,
  );
}

export function createWorkflow(shared: Shared, teamMembers: () => { id: string; name: string }[]) {
  const { db, requireRow, log, setOwner, endAgent, withdrawQuestion, toTicket } = shared;

  /**
   * Sends an in-progress ticket back to New, with no owner, so anyone on the team can take it.
   * An open question to the customer is withdrawn first, with its own history entry, and any
   * assistant's work on the ticket ends, as on a hand-off. Call it inside a transaction.
   */
  function returnToNew(
    key: string,
    before: repository.TicketRow,
    actor: Actor,
  ): repository.TicketRow {
    requireOwnerOrAdminReturns(key, before, actor);
    const now = new Date().toISOString();
    if (before.ready_at !== null) {
      repository.clearReady(db, before.id, now);
      log(before.id, actor, "question_withdrawn", {}, now);
    }
    endAgent(before, "the ticket went back to New", actor, now);
    // The status first: the database refuses an in-progress ticket without an owner.
    repository.updateTicketStatus(db, before.id, "new", now);
    const unowned = setOwner(before, null, null, actor);
    log(before.id, actor, "status_changed", { from: before.status, to: "new" }, now);
    return { ...unowned, status: "new", ...noQuestion, updated_at: now };
  }

  return {
    /**
     * Checks the input, then saves the new status and its event together. It starts work or
     * sends the ticket back to New; it never resolves one.
     */
    changeStatus(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        // An agent asking to resolve gets the real reason first, whatever its scopes: nobody
        // resolves a ticket by changing its status.
        const asked = changeStatusSchema.safeParse(input);
        if (
          actor.kind === "agent" &&
          asked.success &&
          asked.data.status === "resolved" &&
          before.status !== "resolved"
        ) {
          throw needsCustomer(key);
        }
        requirePermission(actor, "change_status", before);
        const { status, expected_version } = parse(changeStatusSchema, input);
        requireNotArchived(key, before);
        if (before.status === status) {
          // Work that has started is the owner's: anyone else asking to start it is refused,
          // even though nothing would change. Asking for New on a New ticket changes nothing.
          if (status === "in_progress") requireOwnerStarts(key, before, actor);
          return before; // nothing changes, so nothing is logged
        }
        if (status === "resolved") throw needsCustomer(key);
        // The status moves only by the workflow's own steps: start work, or send it back to New.
        if (before.status === "resolved") {
          throw new HttpError(
            409,
            "only_filer_reopens",
            `Ticket ${key} is resolved. A resolved ticket moves only by reopening it.`,
          );
        }
        if (status === "new") {
          // Checked here so the owner rule answers before the version check.
          // returnToNew checks it again for its other callers.
          requireOwnerOrAdminReturns(key, before, actor);
          requireVersion(key, before, expected_version);
          return returnToNew(key, before, actor);
        }
        requireOwnerStarts(key, before, actor);
        requireVersion(key, before, expected_version);
        const now = new Date().toISOString();
        repository.updateTicketStatus(db, before.id, status, now);
        log(before.id, actor, "status_changed", { from: before.status, to: status }, now);
        return { ...before, status, ready_at: null, ready_token: null, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * Makes the actor the owner of an unowned ticket. A ticket someone else owns is refused:
     * giving it to someone else is a hand-off.
     */
    takeTicket(key: string, actor: Actor, input: unknown = {}): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "take", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        requireNotArchived(key, before);
        if (before.owner_id === actor.id) return before; // already theirs
        // Take is for the inbox. Someone else's ticket is handed over, not taken.
        if (before.owner_id !== null) {
          throw new HttpError(
            409,
            "already_owned",
            `${before.owner_name ?? "Someone"} already owns ticket ${key}.`,
          );
        }
        if (before.status === "resolved") {
          throw new HttpError(409, "not_open", `Ticket ${key} is resolved.`);
        }
        requireVersion(key, before, expected_version);
        return setOwner(before, actor.id, actor.name, actor);
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * Takes an unowned ticket and starts work on it, in one step. A ticket someone else owns
     * is refused: taking it from them is a hand-off.
     */
    takeAndStart(key: string, actor: Actor, input: unknown = {}): Ticket {
      const row = db.transaction(() => {
        let before = requireRow(key, actor);
        requirePermission(actor, "take", before);
        requirePermission(actor, "change_status", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        requireNotArchived(key, before);
        if (before.status !== "new") {
          throw new HttpError(
            409,
            "not_new",
            `Ticket ${key} is not new, so there is nothing to start.`,
          );
        }
        if (before.owner_id !== null && before.owner_id !== actor.id) {
          throw new HttpError(
            409,
            "already_owned",
            `${before.owner_name ?? "Someone"} already owns ticket ${key}.`,
          );
        }
        requireVersion(key, before, expected_version);
        if (before.owner_id === null) before = setOwner(before, actor.id, actor.name, actor);
        const now = new Date().toISOString();
        repository.updateTicketStatus(db, before.id, "in_progress", now);
        log(before.id, actor, "status_changed", { from: "new", to: "in_progress" }, now);
        return { ...before, status: "in_progress" as const, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /** Leaves the ticket without an owner. Only its owner, and not while it is in progress. */
    releaseTicket(key: string, actor: Actor, input: unknown = {}): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "release", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        requireNotArchived(key, before);
        if (before.owner_id === null) {
          throw new HttpError(
            409,
            "no_owner",
            `Nobody owns ticket ${key}, so there is nothing to release.`,
          );
        }
        // Only the owner lets go of a ticket, and only before work starts.
        if (before.owner_id !== actor.id) {
          throw new HttpError(
            403,
            "not_owner",
            `Only ${before.owner_name ?? "its owner"}, who owns ticket ${key}, can release it.`,
          );
        }
        if (before.status === "resolved") {
          throw new HttpError(409, "not_open", `Ticket ${key} is resolved.`);
        }
        if (before.status === "in_progress") {
          throw new HttpError(
            409,
            "keeps_owner",
            `Ticket ${key} is in progress, so it must keep an owner. Someone else can take it.`,
          );
        }
        requireVersion(key, before, expected_version);
        return setOwner(before, null, null, actor);
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The owner, or an admin, hands the ticket straight to another team member. The form says
     * whom it expects to own the ticket now, so a hand-off made from an old page is refused. An
     * open question to the customer is withdrawn: the new owner asks again.
     */
    handOff(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "hand_off", before);
        const { to, expected_owner, expected_version } = parse(handOffSchema, input);
        requireNotArchived(key, before);
        if (before.status === "resolved") {
          throw new HttpError(409, "not_open", `Ticket ${key} is resolved.`);
        }
        if (before.owner_id !== actor.id && actor.role !== "admin") {
          throw new HttpError(
            403,
            "not_owner",
            `Only ${before.owner_name ?? "its owner"}, who owns ticket ${key}, or an admin can hand it off.`,
          );
        }
        if ((before.owner_id ?? "") !== expected_owner) {
          throw new HttpError(
            409,
            "owner_changed",
            `Ticket ${key} has changed hands since you opened it. Reload it and try again.`,
          );
        }
        const target = teamMembers().find((member) => member.id === to);
        if (target === undefined) {
          throw new ValidationError("Choose a team member.", { to: ["Choose a team member."] });
        }
        if (target.id === before.owner_id) return before;
        requireVersion(key, before, expected_version);
        withdrawQuestion(before);
        // A new owner chooses their own help: the old owner's agent hand-off ends.
        endAgent(before, "the ticket changed hands", actor, new Date().toISOString());
        return {
          ...setOwner(before, target.id, target.name, actor),
          ready_at: null,
          ready_token: null,
        };
      })();
      return toTicket(saved(db, row), actor);
    },

    /** The team members this ticket could be handed to: everyone eligible but its owner. */
    handOffCandidates(ticket: Ticket): { id: string; name: string }[] {
      return teamMembers().filter((member) => member.id !== ticket.owner_id);
    },
  };
}

import type { Actor } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { parse } from "../validation.js";
import {
  requireNotArchived,
  requirePermission,
  requireRoom,
  requireVersion,
  saved,
} from "./checks.js";
import { noQuestion } from "./history.js";
import { buildKey, parseKey } from "./keys.js";
import * as repository from "./repository.js";
import { reopenSchema, resolveSchema } from "./schemas.js";
import type { Shared } from "./shared.js";
import type { Ticket } from "./types.js";

// The team resolving a ticket with a reason, and reopening a resolved ticket. The customer's
// own Yes, the other way a ticket is resolved, is in customer-question.ts.

/**
 * isOnTeam answers whether a person may own a ticket now. A ticket reopened while its owner is
 * not goes back to New with no owner.
 */
export function createResolveAndReopen(shared: Shared, isOnTeam: (personId: string) => boolean) {
  const { db, prefix, budget, requireRow, log, setOwner, endAgent, toTicket } = shared;

  return {
    /**
     * The ticket's owner, or an admin, resolves it without the customer's Yes, with a reason
     * from the list. A team member may also resolve a ticket nobody owns yet; whoever resolves
     * an unowned ticket becomes its owner, with its own history entry, so a named person stands
     * behind the resolution and can reopen it. The ticket then shows as "Resolved by the team:
     * <reason>" wherever the ticket does, apart from "Customer confirmed". An open question to
     * the customer is withdrawn first, with its own history entry, and any assistant's work on
     * the ticket ends. The customer who filed it can reopen it, as after their own Yes. An agent
     * never resolves, by this or any door.
     */
    resolveWithReason(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        let before = requireRow(key, actor);
        requirePermission(actor, "resolve_with_reason", before);
        const { reason, note, duplicate_of, expected_version } = parse(resolveSchema, input);
        if (reason === "other" && !note) {
          throw new ValidationError("Say why, for Other.", { note: ["Say why, for Other."] });
        }
        if (reason === "duplicate" && !duplicate_of) {
          throw new ValidationError("Name the ticket this one duplicates.", {
            duplicate_of: ["Name the ticket this one duplicates, such as SUP-3."],
          });
        }
        requireNotArchived(key, before);
        if (before.owner_id !== null && before.owner_id !== actor.id && actor.role !== "admin") {
          throw new HttpError(
            403,
            "not_owner",
            `Only ${before.owner_name}, who owns ticket ${key}, or an admin can resolve it with a reason.`,
          );
        }
        if (before.status === "resolved") {
          throw new HttpError(409, "not_open", `Ticket ${key} is already resolved.`);
        }
        // The customer's standing word is that it is not fixed (a No, or their reopening it,
        // and nobody has asked them again since): then that reason would not be true.
        if (
          reason === "fixed_no_reply" &&
          before.ready_at === null &&
          repository.customerSaysNotFixed(db, before.id)
        ) {
          throw new ValidationError("The customer said it is not fixed. Choose another reason.", {
            reason: ["The customer said it is not fixed. Choose another reason."],
          });
        }
        let duplicateOf: string | null = null;
        if (reason === "duplicate") {
          // A key typed in lower case, such as sup-3, names the same ticket.
          const otherId = parseKey(prefix, duplicate_of!.toUpperCase());
          const other = otherId === null ? undefined : repository.findTicket(db, otherId);
          if (other === undefined || other.id === before.id) {
            throw new ValidationError("Name another ticket that exists.", {
              duplicate_of: ["Name another ticket that exists, such as SUP-3."],
            });
          }
          duplicateOf = buildKey(prefix, other.id);
        }
        requireVersion(key, before, expected_version);
        // Nobody owns it yet: the person resolving it becomes its owner first.
        if (before.owner_id === null) before = setOwner(before, actor.id, actor.name, actor);
        const now = new Date().toISOString();
        if (before.ready_at !== null) {
          repository.clearReady(db, before.id, now);
          log(before.id, actor, "question_withdrawn", {}, now);
        }
        endAgent(before, "the team resolved the ticket", actor, now);
        const resolution = {
          reason,
          note: note ?? null,
          duplicateOf,
          by: actor.id,
          byName: actor.name,
        };
        repository.resolveByTeam(db, before.id, resolution, now);
        log(
          before.id,
          actor,
          "resolved_by_team",
          { reason, note: resolution.note, duplicate_of: duplicateOf, from: before.status },
          now,
        );
        return {
          ...before,
          status: "resolved" as const,
          ready_at: null,
          ready_token: null,
          resolved_reason: reason,
          resolved_note: resolution.note,
          resolved_duplicate_of: duplicateOf,
          resolved_by: actor.id,
          resolved_by_name: actor.name,
          resolved_at: now,
          updated_at: now,
        };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The customer who filed a resolved ticket says it is still happening. It goes back to
     * its owner, in progress, or to the inbox if it has none. An owner who is no longer on the
     * team cannot work on it, so then it goes to the inbox with no owner, which the history says. Their reason is a public reply,
     * and their earlier Yes stays in the history.
     *
     * The ticket's owner, or an admin, may also reopen a ticket the team resolved, to undo a
     * resolution made by mistake. Their reason goes into the history, which the customer sees.
     * A ticket the customer confirmed with their Yes stays theirs to reopen.
     */
    reopen(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "reopen", before);
        // Who may reopen is checked before what they sent, as for every action.
        const byCustomer = before.created_by === actor.id;
        if (!byCustomer && before.status === "resolved") {
          // A resolution by the team has a reason. The customer's Yes has none.
          if (before.resolved_reason === null) {
            throw new HttpError(
              403,
              "customer_confirmed",
              `The customer confirmed ticket ${key} is fixed. Only they can reopen it.`,
            );
          }
          if (before.owner_id !== actor.id && actor.role !== "admin") {
            throw new HttpError(
              403,
              "not_owner",
              before.owner_name === null
                ? `Only an admin can reopen ticket ${key}: it has no owner.`
                : `Only ${before.owner_name}, who owns ticket ${key}, or an admin can reopen it.`,
            );
          }
        }
        const { reason, expected_version } = parse(reopenSchema, input);
        requireNotArchived(key, before);
        if (before.status !== "resolved") {
          throw new HttpError(
            409,
            "not_resolved",
            `Ticket ${key} is not resolved, so it is still open.`,
          );
        }
        if (byCustomer) {
          requireRoom(
            () => repository.countRows(db, "ticket_entries", before.id),
            budget.entriesPerTicket,
            "replies on this ticket",
          );
        }
        requireVersion(key, before, expected_version);
        let reopened = before;
        if (reopened.owner_id !== null && !isOnTeam(reopened.owner_id)) {
          reopened = setOwner(reopened, null, null, actor);
        }
        const status = reopened.owner_id === null ? "new" : "in_progress";
        const now = new Date().toISOString();
        repository.updateTicketStatus(db, before.id, status, now);
        if (byCustomer) {
          repository.insertEntry(db, {
            ticket_id: before.id,
            kind: "reply",
            body: reason,
            author: actor.id,
            author_kind: actor.kind,
            author_role: actor.role,
            author_name: actor.name,
            created_at: now,
          });
          log(
            before.id,
            actor,
            "reopened",
            { reason, to: status, owner: reopened.owner_name },
            now,
          );
        } else {
          log(
            before.id,
            actor,
            "reopened_by_team",
            { reason, to: status, owner: reopened.owner_name },
            now,
          );
        }
        return { ...reopened, status, ...noQuestion, updated_at: now } as repository.TicketRow;
      })();
      return toTicket(saved(db, row), actor);
    },
  };
}

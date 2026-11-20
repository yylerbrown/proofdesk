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
import { buildKey } from "./keys.js";
import * as repository from "./repository.js";
import {
  agreeCheckSchema,
  createTicketSchema,
  deleteTicketSchema,
  editTicketSchema,
  linkChangeSchema,
  sameText,
  versionOnlySchema,
} from "./schemas.js";
import type { Shared } from "./shared.js";
import type { Ticket } from "./types.js";

/**
 * Filing a ticket and changing what it says: its text, the customer's check and the team's
 * interpretation of it, the change link; archiving, restoring and deleting it.
 */
export function createFiling(shared: Shared) {
  const { db, prefix, budget, requireRow, log, endAgent, withdrawQuestion, toTicket } = shared;

  return {
    /** Checks the input, then saves the ticket and its "created" event together. */
    createTicket(input: unknown, actor: Actor): Ticket {
      requirePermission(actor, "create");
      const ticket = parse(createTicketSchema, input);
      const now = new Date().toISOString();
      const row = db.transaction(() => {
        requireRoom(() => repository.countTickets(db), budget.tickets, "tickets");
        const id = repository.insertTicket(db, {
          title: ticket.title,
          description: ticket.description,
          whereUrl: ticket.where_url ?? null,
          fixCheck: ticket.fix_check || null,
          createdBy: actor.id,
          now,
        });
        log(id, actor, "created", { status: "new" }, now);
        return repository.findTicket(db, id)!;
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * Replaces the text of a ticket: title, description, link and check. The input has the
     * same shape and rules as a new ticket, with the version the caller saw. The event records
     * each field that changed, with its old and new value. If nothing changed, nothing is
     * written. An open question to the customer is withdrawn, since it was about the old text.
     */
    editTicket(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "edit", before);
        const ticket = parse(editTicketSchema, input);
        const after = {
          title: ticket.title,
          description: ticket.description,
          where_url: ticket.where_url ?? null,
          fix_check: ticket.fix_check || null,
        };
        requireNotArchived(key, before);
        // The check is the customer's own words. The team edits the rest, never those.
        const isFiler = before.created_by === actor.id;
        if (!isFiler) after.fix_check = before.fix_check;
        // Stored text may still hold old line endings: the same words are not a change.
        const changes: Record<string, { from: string | null; to: string | null }> = {};
        for (const field of ["title", "description", "where_url", "fix_check"] as const) {
          if (!sameText(before[field], after[field])) {
            changes[field] = { from: before[field], to: after[field] };
          }
        }
        if (Object.keys(changes).length === 0) return before;
        requireVersion(key, before, ticket.expected_version);
        const now = new Date().toISOString();
        withdrawQuestion(before);
        repository.updateTicketText(
          db,
          before.id,
          {
            title: after.title,
            description: after.description,
            whereUrl: after.where_url,
            fixCheck: after.fix_check,
          },
          now,
        );
        log(before.id, actor, "edited", { changes }, now);
        // A customer who changes their check retires the team's interpretation of the old one.
        let agreed = before.agreed_check;
        if (changes.fix_check !== undefined && before.agreed_check !== null) {
          repository.updateAgreedCheck(db, before.id, null, now);
          log(before.id, actor, "check_agreed", { from: before.agreed_check, to: null }, now);
          agreed = null;
        }
        return { ...before, ...after, agreed_check: agreed, ...noQuestion, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The customer adopts the team's interpretation as their own check, in those exact words.
     * Their earlier words stay in the history.
     */
    adoptCheck(key: string, actor: Actor, input: unknown = {}): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "adopt_check", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        requireNotArchived(key, before);
        if (before.agreed_check === null) {
          throw new HttpError(
            409,
            "no_interpretation",
            `Ticket ${key} has no wording from the team to adopt.`,
          );
        }
        requireVersion(key, before, expected_version);
        const now = new Date().toISOString();
        const words = before.agreed_check;
        // The question was about the old words, so it is withdrawn.
        withdrawQuestion(before);
        repository.updateTicketText(
          db,
          before.id,
          {
            title: before.title,
            description: before.description,
            whereUrl: before.where_url,
            fixCheck: words,
          },
          now,
        );
        repository.updateAgreedCheck(db, before.id, null, now);
        log(before.id, actor, "check_adopted", { from: before.fix_check, to: words }, now);
        return { ...before, fix_check: words, agreed_check: null, ...noQuestion, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * Sets the team's interpretation of the customer's check, or removes it with an empty text.
     * The customer's own words in fix_check are never changed by this.
     */
    agreeCheck(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "agree_check", before);
        const { agreed_check, expected_version } = parse(agreeCheckSchema, input);
        // The same words as the customer's are not a tighter check: keep none.
        // Stored text may still hold old line endings, so both checks compare with sameText.
        const agreed =
          agreed_check === "" || sameText(agreed_check, before.fix_check) ? null : agreed_check;
        requireNotArchived(key, before);
        if (sameText(before.agreed_check, agreed)) return before; // nothing changes
        requireVersion(key, before, expected_version);
        const now = new Date().toISOString();
        withdrawQuestion(before);
        repository.updateAgreedCheck(db, before.id, agreed, now);
        log(before.id, actor, "check_agreed", { from: before.agreed_check, to: agreed }, now);
        return { ...before, agreed_check: agreed, ...noQuestion, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /** Records the link to the code change. Evidence, not proof that the ticket is fixed. */
    linkChange(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "link_change", before);
        const { change_url, expected_version } = parse(linkChangeSchema, input);
        requireNotArchived(key, before);
        if (before.change_url === change_url) return before;
        requireVersion(key, before, expected_version);
        const now = new Date().toISOString();
        withdrawQuestion(before);
        repository.updateChangeUrl(db, before.id, change_url, now);
        log(before.id, actor, "change_linked", { from: before.change_url, to: change_url }, now);
        return { ...before, change_url, ...noQuestion, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * Hides the ticket from the ordinary lists. Its row and its events are kept. An open
     * question to the customer is withdrawn and any assistant's work on it ends.
     */
    archiveTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "archive", before);
        if (before.archived_at !== null) return before; // already archived
        const now = new Date().toISOString();
        withdrawQuestion(before);
        endAgent(before, "the ticket was archived", actor, now);
        repository.updateTicketArchived(db, before.id, now, now);
        log(before.id, actor, "archived", {}, now);
        return { ...before, archived_at: now, ...noQuestion, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /** Brings an archived ticket back into the ordinary lists. Not for customers. */
    restoreTicket(key: string, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "restore", before);
        if (before.archived_at === null) return before; // not archived
        const now = new Date().toISOString();
        repository.updateTicketArchived(db, before.id, null, now);
        log(before.id, actor, "restored", {}, now);
        return { ...before, archived_at: null, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * Deletes the ticket and everything that belongs to it, for good. Only its number, the
     * time and who did it are kept. The input must repeat the ticket's key, so that it
     * cannot happen by a slip.
     */
    deleteTicket(key: string, input: unknown, actor: Actor): { filesCleaned: boolean } {
      db.transaction(() => {
        const row = requireRow(key, actor);
        requirePermission(actor, "delete", row);
        const { confirm } = parse(deleteTicketSchema, input);
        const exactKey = buildKey(prefix, row.id);
        if (confirm !== exactKey) {
          throw new ValidationError(`Type ${exactKey} to confirm.`, {
            confirm: [`Type ${exactKey} to confirm.`],
          });
        }
        repository.deleteTicketForever(db, row.id, actor.id, new Date().toISOString());
      })();
      // The ticket is gone from the database now. Whether its old text has also left the
      // files on disk depends on the checkpoint, which reports it. A checkpoint cannot run
      // inside an open transaction, and a write sent with an idempotency key runs inside
      // one, so then the files are left for the next checkpoint and the answer says so.
      const filesCleaned = db.inTransaction ? false : repository.flushDeletedContent(db);
      return { filesCleaned };
    },
  };
}

import { randomUUID } from "node:crypto";
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
import * as repository from "./repository.js";
import { answerSchema, markReadySchema, sameText, versionOnlySchema } from "./schemas.js";
import type { Shared } from "./shared.js";
import { THREAD_LIMIT, type Ticket } from "./types.js";

// The question "Did this fix it?": the owner asks it, may withdraw it, and the customer
// answers it. The customer may also confirm a ticket the team marked fixed. The customer's Yes,
// by either door, is the one way a ticket shows as "Customer confirmed".

export function createCustomerQuestion(shared: Shared) {
  const { db, budget, requireRow, log, endAgent, toTicket } = shared;

  return {
    /**
     * Asks the customer "Did this fix it?". The ticket must be in progress, and only its owner
     * asks. Everything else is optional: a page to try, what the owner tried and what happened,
     * what changed since the customer's last No, and evidence. The customer sees each one given.
     */
    markReady(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "mark_ready", before);
        // Every field is optional, so a request with no body at all asks with nothing else.
        const fields = parse(markReadySchema, input ?? {});
        requireNotArchived(key, before);
        // Only the ticket's current owner asks the customer.
        if (before.owner_id === null) {
          throw new HttpError(
            403,
            "not_owner",
            `Nobody owns ticket ${key} yet. Take it and start work first.`,
          );
        }
        if (before.owner_id !== actor.id) {
          throw new HttpError(
            403,
            "not_owner",
            `Only ${before.owner_name}, who owns ticket ${key}, can ask the customer.`,
          );
        }
        // Worded from the ticket as it is now, which a page opened earlier may not show.
        if (before.status === "resolved") {
          throw new HttpError(
            409,
            "not_in_progress",
            `Ticket ${key} was resolved, so nothing was sent. Reopen it first if it needs another check.`,
          );
        }
        if (before.status !== "in_progress") {
          throw new HttpError(409, "not_in_progress", `Move ticket ${key} to In Progress first.`);
        }
        const try_url = fields.try_url ?? null;
        const tried = fields.tried || null;
        const result = fields.result || null;
        const response = fields.response || null;
        const evidenceIds = fields.evidence_ids ?? [];
        // Already waiting for an answer. The very same question again is a retry, and changes
        // nothing. A different one would change what the customer is answering: withdraw first.
        // Stored text may still hold old line endings, so the words compare with sameText.
        if (before.ready_at !== null) {
          const same =
            before.try_url === try_url &&
            sameText(before.ready_tried, tried) &&
            sameText(before.ready_result, result) &&
            sameText(before.ready_response ?? null, response) &&
            (before.ready_evidence ?? "[]") === JSON.stringify(evidenceIds);
          if (same) return before;
          throw new HttpError(
            409,
            "question_open",
            `The customer is already answering a question on ${key}. Withdraw it first to ask a different one.`,
          );
        }
        // The evidence relied on must be this ticket's own.
        const own = new Set(repository.listEvidence(db, before.id, THREAD_LIMIT).map((e) => e.id));
        if (evidenceIds.some((id) => !own.has(id))) {
          throw new ValidationError("Choose evidence attached to this ticket.", {
            evidence_ids: ["Choose evidence attached to this ticket."],
          });
        }
        requireVersion(key, before, fields.expected_version);
        const ask = { tryUrl: try_url, tried, result, response, evidenceIds };
        const now = new Date().toISOString();
        // Asking the customer ends any agent's work on the ticket.
        endAgent(before, "the customer was asked", actor, now);
        const token = randomUUID();
        repository.updateReady(db, before.id, ask, token, now);
        log(
          before.id,
          actor,
          "ready_for_customer",
          { try_url, tried, result, response: ask.response, evidence_ids: evidenceIds },
          now,
        );
        return {
          ...before,
          try_url,
          ready_tried: tried,
          ready_result: result,
          ready_response: ask.response,
          ready_evidence: JSON.stringify(evidenceIds),
          ready_at: now,
          ready_token: token,
          updated_at: now,
        };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The owner takes back the question the customer has not answered yet, for example to
     * change what it says. The customer's open answer form stops working.
     */
    withdrawQuestionAsked(key: string, actor: Actor, input: unknown = {}): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "mark_ready", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        if (before.owner_id !== actor.id) {
          throw new HttpError(
            403,
            "not_owner",
            `Only the owner of ticket ${key} can withdraw its question.`,
          );
        }
        // Archiving already withdrew any question.
        requireNotArchived(key, before);
        if (before.ready_at === null) return before; // nothing is open
        requireVersion(key, before, expected_version);
        const now = new Date().toISOString();
        repository.clearReady(db, before.id, now);
        log(before.id, actor, "question_withdrawn", {}, now);
        return { ...before, ready_at: null, ready_token: null, updated_at: now };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The customer's answer to "Did this fix it?". Yes resolves the ticket. No puts it back
     * in progress with its owner, and the customer's comment goes into the conversation.
     */
    answer(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "answer", before);
        const { fixed, comment, ready_token } = parse(answerSchema, input);
        if (fixed === "no" && !comment) {
          throw new ValidationError("Say what is still wrong.", {
            comment: ["Say what is still wrong."],
          });
        }
        requireNotArchived(key, before);
        if (before.ready_at === null) {
          throw new HttpError(409, "not_waiting", `Ticket ${key} is not waiting for an answer.`);
        }
        // The answer must be to the question the customer was shown, not an older one.
        if (before.ready_token !== ready_token) {
          throw new HttpError(
            409,
            "question_changed",
            `The question on ticket ${key} has changed. Reload the ticket and answer again.`,
          );
        }
        // A No adds the customer's words, so it fits the same budget as any other reply.
        if (fixed === "no") {
          requireRoom(
            () => repository.countRows(db, "ticket_entries", before.id),
            budget.entriesPerTicket,
            "replies on this ticket",
          );
        }
        const now = new Date().toISOString();
        const status = fixed === "yes" ? "resolved" : "in_progress";
        repository.updateTicketStatus(db, before.id, status, now);
        if (fixed === "no") {
          repository.insertEntry(db, {
            ticket_id: before.id,
            kind: "reply",
            body: comment!,
            author: actor.id,
            author_kind: actor.kind,
            author_role: actor.role,
            author_name: actor.name,
            created_at: now,
          });
        }
        // A no keeps the customer's words with the answer, so the owner sees them with it.
        log(
          before.id,
          actor,
          "customer_answered",
          fixed === "yes" ? { fixed: true } : { fixed: false, comment },
          now,
        );
        return { ...before, status, ...noQuestion, updated_at: now } as repository.TicketRow;
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The customer confirms a ticket the team resolved as fixed. Only the customer who filed it
     * may, as for answer. The ticket ends exactly as a Yes to the question leaves it: resolved,
     * with no team reason, so it shows as "Customer confirmed". Pressing it again on a ticket
     * the customer already confirmed changes nothing.
     */
    confirmFix(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "answer", before);
        const { expected_version } = parse(versionOnlySchema, input ?? {});
        requireNotArchived(key, before);
        // Already confirmed by the customer: a resolved ticket with no team reason.
        if (before.status === "resolved" && before.resolved_reason === null) return before;
        if (before.status !== "resolved" || before.resolved_reason !== "fixed_no_reply") {
          throw new HttpError(409, "not_waiting", `Ticket ${key} is not waiting for your answer.`);
        }
        requireVersion(key, before, expected_version);
        const now = new Date().toISOString();
        // Setting the status again clears the team's reason, which makes it the customer's.
        repository.updateTicketStatus(db, before.id, "resolved", now);
        log(before.id, actor, "customer_answered", { fixed: true }, now);
        return {
          ...before,
          ...noQuestion,
          resolved_reason: null,
          resolved_note: null,
          resolved_duplicate_of: null,
          resolved_by: null,
          resolved_by_name: null,
          resolved_at: null,
          updated_at: now,
        } as repository.TicketRow;
      })();
      return toTicket(saved(db, row), actor);
    },
  };
}

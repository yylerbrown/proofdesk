import { z } from "zod";
import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { HttpError } from "../errors.js";
import { parse } from "../validation.js";
import { requireNotArchived, requirePermission, requireVersion, saved } from "./checks.js";
import { noQuestion } from "./history.js";
import { buildKey } from "./keys.js";
import * as repository from "./repository.js";
import { blankIsMissing, expectedVersion, sameText, textBox } from "./schemas.js";
import type { Shared } from "./shared.js";
import type { Ticket } from "./types.js";

// Ways to verify a new ticket, suggested by an assistant and picked by the customer.
//
// Proofdesk calls no assistant itself. A team's own assistant, on a connection an admin allowed
// to suggest, reads the New tickets that have no check and offers up to three ways the customer
// could check the fix. The customer picks one, or writes their own, and that becomes the
// ticket's check. Until then the words are only the assistant's suggestion, shown as such.

/** The most ways to verify a ticket may be offered at once, by every assistant together. */
export const MOST_SUGGESTED_CHECKS = 3;

const oneWay = z
  .string()
  .trim()
  .min(3, "Each way to verify must be at least 3 characters.")
  .max(200, "Each way to verify must be at most 200 characters.");

export const suggestChecksSchema = z.object({
  options: z
    .array(oneWay)
    .min(1, "Offer at least one way to verify.")
    .max(MOST_SUGGESTED_CHECKS, `Offer at most ${MOST_SUGGESTED_CHECKS} ways to verify.`)
    .meta({
      description:
        "One to three ways the customer could check the fix themselves, each one thing they can do and see, in plain words.",
    }),
});

// The customer's check, as the box on their page holds it. The words are the only thing saved.
// suggestion_id names the suggestion the box started from, kept for the history line even when
// the words were edited. With an empty box and a suggestion_id, the suggestion's own words are
// saved, which is what a page with scripts off sends when one is picked.
export const chooseCheckSchema = z
  .object({
    words: z
      .preprocess(blankIsMissing, textBox().max(500, "Must be at most 500 characters.").optional())
      .meta({ description: "How you will know it is fixed, in your own words." }),
    suggestion_id: z
      .preprocess(blankIsMissing, z.coerce.number().int().positive().optional())
      .meta({ description: "The id of the suggested way to verify the words started from." }),
    expected_version: expectedVersion,
  })
  .refine((choice) => choice.words !== undefined || choice.suggestion_id !== undefined, {
    message: "Pick one of the suggestions, or write how you will know it is fixed.",
    path: ["words"],
  });

/** One suggested way to verify, as people and programs see it: always marked as suggested. */
export type CheckSuggestion = {
  id: number;
  words: string;
  offered_by: { kind: "agent"; name: string };
  offered_at: string;
  state: repository.SuggestionState;
};

/** What an assistant allowed to suggest reads of a New ticket that has no check: this, only. */
export type TicketWantingCheck = {
  key: string;
  title: string;
  description: string;
  created_at: string;
};

function toSuggestion(row: repository.SuggestionRow): CheckSuggestion {
  return {
    id: row.id,
    words: row.words,
    offered_by: { kind: "agent", name: row.offered_by_name },
    offered_at: row.created_at,
    state: row.state,
  };
}

/**
 * Stores the ways one connection offers on a ticket, in place of what it offered before. Every
 * assistant together offers at most three on a ticket. Call it inside a transaction, once the
 * caller has checked the ticket waits for a way to verify it. The ticket's row is not changed.
 */
export function storeSuggestions(
  db: Db,
  prefix: string,
  row: repository.TicketRow,
  options: string[],
  connection: { id: number; name: string },
): { ticket_key: string; suggestions: CheckSuggestion[] } {
  const key = buildKey(prefix, row.id);
  const others = repository.countOfferedByOthers(db, row.id, connection.id);
  if (others + options.length > MOST_SUGGESTED_CHECKS) {
    throw new HttpError(
      409,
      "suggestions_full",
      `Ticket ${key} holds at most ${MOST_SUGGESTED_CHECKS} suggested ways to verify, and other assistants offer ${others}.`,
    );
  }
  const now = new Date().toISOString();
  repository.deleteOfferedBy(db, row.id, connection.id);
  for (const words of options) {
    repository.insertSuggestion(db, {
      ticketId: row.id,
      connectionId: connection.id,
      offeredByName: connection.name,
      words,
      now,
    });
  }
  const own = repository
    .listSuggestions(db, row.id)
    .filter((suggestion) => suggestion.connection_id === connection.id)
    .filter((suggestion) => suggestion.state === "offered");
  return { ticket_key: key, suggestions: own.map(toSuggestion) };
}

export function createSuggestedChecks(shared: Shared) {
  const { db, prefix, requireRow, requireRowWantingCheck, log, withdrawQuestion, toTicket } =
    shared;

  return {
    /**
     * An assistant offers ways to verify a New ticket that has no check. It replaces what the
     * same connection offered before. Every assistant together offers at most three on a
     * ticket. The ticket's row is not changed, so its version stays and an open page is not
     * made stale.
     */
    suggestChecks(
      key: string,
      input: unknown,
      actor: Actor,
    ): { ticket_key: string; suggestions: CheckSuggestion[] } {
      return db.transaction(() => {
        requirePermission(actor, "suggest_checks");
        const row = requireRowWantingCheck(key, actor);
        const { options } = parse(suggestChecksSchema, input);
        return storeSuggestions(db, prefix, row, options, actor.connection!);
      })();
    },

    /**
     * The customer who filed the ticket sets or changes its check from their page: the words in
     * the box, which may have started from a suggestion. A suggestion still offered is marked
     * chosen, even when its words were edited, and the others withdrawn. Changing a check that
     * is already there does what editing the check does: it withdraws an open question, retires
     * the team's wording, and the history keeps both wordings.
     */
    chooseCheck(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "choose_check", before);
        const choice = parse(chooseCheckSchema, input ?? {});
        requireNotArchived(key, before);
        const named = repository
          .listSuggestions(db, before.id)
          .find((suggestion) => suggestion.id === choice.suggestion_id);
        // A suggestion withdrawn since the page was opened gives no words of its own, but the
        // words in the box are still saved. One already chosen gives its words again, so the
        // second press of a double click finds them the same.
        const usable = named !== undefined && named.state !== "withdrawn" ? named : undefined;
        const words = choice.words ?? usable?.words;
        if (words === undefined) {
          throw new HttpError(
            409,
            "suggestion_gone",
            "That suggestion is no longer offered. Pick another, or write your own.",
          );
        }
        // The second press of a double click changes nothing.
        if (sameText(before.fix_check, words)) return before;
        requireVersion(key, before, choice.expected_version);
        const now = new Date().toISOString();
        // A question to the customer was about the old check, so it is withdrawn.
        withdrawQuestion(before);
        // Only a suggestion still offered becomes the chosen one.
        const picked = named?.state === "offered" ? named : undefined;
        if (picked !== undefined) repository.markChosen(db, picked.id);
        // Setting the check withdraws every suggestion still offered, by a trigger.
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
        log(
          before.id,
          actor,
          "check_chosen",
          { from: before.fix_check, to: words, suggested_by: picked?.offered_by_name ?? null },
          now,
        );
        // As when the customer edits their check: the team's interpretation of the old one is
        // retired.
        let agreed = before.agreed_check;
        if (agreed !== null) {
          repository.updateAgreedCheck(db, before.id, null, now);
          log(before.id, actor, "check_agreed", { from: agreed, to: null }, now);
          agreed = null;
        }
        return {
          ...before,
          fix_check: words,
          agreed_check: agreed,
          ...noQuestion,
          updated_at: now,
        };
      })();
      return toTicket(saved(db, row), actor);
    },

    /**
     * The suggested ways to verify a ticket, for whoever may read it: the customer who filed it
     * and the team see them all; an assistant sees only its own.
     */
    listCheckSuggestions(key: string, actor: Actor): CheckSuggestion[] {
      const row = requireRow(key, actor);
      const rows = repository.listSuggestions(db, row.id);
      if (actor.kind === "agent") {
        return rows
          .filter((suggestion) => suggestion.connection_id === actor.connection?.id)
          .map(toSuggestion);
      }
      return rows.map(toSuggestion);
    },

    /**
     * What an assistant allowed to suggest may read of a New ticket with no check: its key,
     * title, description and filed time, and nothing else. Null for any other ticket or caller,
     * which then reads the ticket as usual or is refused as usual. A ticket handed to the
     * connection is never New, so it is always read in full.
     */
    ticketWantingCheck(key: string, actor: Actor): TicketWantingCheck | null {
      let row: repository.TicketRow;
      try {
        row = requireRowWantingCheck(key, actor);
      } catch (err) {
        if (err instanceof HttpError && err.status === 404) return null;
        throw err;
      }
      return {
        key: buildKey(prefix, row.id),
        title: row.title,
        description: row.description,
        created_at: row.created_at,
      };
    },
  };
}

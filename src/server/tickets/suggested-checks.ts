import { z } from "zod";
import type { Actor } from "../actor.js";
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

// The customer sends either the suggestion they picked or their own words. A form may send an
// empty box for the one it did not use, which counts as not sent.
export const chooseCheckSchema = z
  .object({
    suggestion_id: z
      .preprocess(blankIsMissing, z.coerce.number().int().positive().optional())
      .meta({ description: "The id of the suggested way to verify you picked." }),
    words: z
      .preprocess(blankIsMissing, textBox().max(500, "Must be at most 500 characters.").optional())
      .meta({ description: "Your own words for how you will know it is fixed." }),
    expected_version: expectedVersion,
  })
  .refine((choice) => (choice.suggestion_id === undefined) !== (choice.words === undefined), {
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
        const connection = actor.connection!;
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
        return { ticket_key: buildKey(prefix, row.id), suggestions: own.map(toSuggestion) };
      })();
    },

    /**
     * The customer who filed the ticket sets its check: to a suggestion they picked, or to their
     * own words. The suggestion picked is marked chosen and the others withdrawn. The history
     * says where the words came from.
     */
    chooseCheck(key: string, input: unknown, actor: Actor): Ticket {
      const row = db.transaction(() => {
        const before = requireRow(key, actor);
        requirePermission(actor, "choose_check", before);
        const choice = parse(chooseCheckSchema, input ?? {});
        requireNotArchived(key, before);
        let picked: repository.SuggestionRow | undefined;
        if (choice.suggestion_id !== undefined) {
          picked = repository
            .listSuggestions(db, before.id)
            .find((suggestion) => suggestion.id === choice.suggestion_id);
          if (picked === undefined) {
            throw new HttpError(
              409,
              "suggestion_gone",
              "That suggestion is no longer offered. Pick another, or write your own.",
            );
          }
        }
        const words = picked?.words ?? choice.words!;
        if (before.fix_check !== null) {
          // The second press of a double click changes nothing.
          if (sameText(before.fix_check, words)) return before;
          throw new HttpError(
            409,
            "check_exists",
            `Ticket ${key} already says how you will know it is fixed. Edit the ticket to change it.`,
          );
        }
        if (picked !== undefined && picked.state !== "offered") {
          throw new HttpError(
            409,
            "suggestion_gone",
            "That suggestion is no longer offered. Pick another, or write your own.",
          );
        }
        requireVersion(key, before, choice.expected_version);
        const now = new Date().toISOString();
        // A question to the customer was about the ticket without a check, so it is withdrawn.
        withdrawQuestion(before);
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
          { to: words, suggested_by: picked?.offered_by_name ?? null },
          now,
        );
        // As when the customer edits their check: the team's interpretation of none is retired.
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

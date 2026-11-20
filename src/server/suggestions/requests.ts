import { z } from "zod";
import type { Actor } from "../actor.js";
import { HttpError } from "../errors.js";
import { requireNotArchived, requirePermission } from "../tickets/checks.js";
import { suggestionSetting, wantsCheck } from "../tickets/access.js";
import { buildKey } from "../tickets/keys.js";
import { findTicket, type TicketRow } from "../tickets/repository.js";
import type { Shared } from "../tickets/shared.js";
import {
  storeSuggestions,
  suggestChecksSchema,
  type CheckSuggestion,
} from "../tickets/suggested-checks.js";
import { parse } from "../validation.js";
import { createListening } from "./listening.js";
import * as repository from "./repository.js";

// A person asking a listening assistant for ways to verify their own filed ticket.
//
// The customer who filed a New ticket with no check asks, by pressing "Suggest ways to verify"
// or by their page asking by itself. Proofdesk keeps the request and hands it to an assistant
// holding a wait_for_requests call, whose admin set its connection to answer that kind of
// request. The first answer is stored as the ticket's suggestions, exactly as suggest_checks
// stores them, and the customer's page shows them.

/** The longest a wait_for_requests call is held open, in seconds. */
export const LONGEST_WAIT_SECONDS = 25;

/** How long a request waits for an answer before it expires, in seconds. */
export const ANSWER_WITHIN_SECONDS = 60;

/** How long a request is kept at all, in minutes. Then its row is removed. */
export const KEPT_FOR_MINUTES = 10;

/** How many requests one person may make in KEPT_FOR_MINUTES minutes. */
export const MOST_REQUESTS_PER_PERSON = 10;

/** Where a person's request for one ticket stands, as their page reads it. */
export type RequestState = "none" | "waiting" | "answered" | "expired";

export const waitForRequestsQuery = z.object({
  wait_seconds: z.coerce
    .number()
    .int()
    .min(1, "Wait at least 1 second.")
    .max(LONGEST_WAIT_SECONDS, `Wait at most ${LONGEST_WAIT_SECONDS} seconds.`)
    .optional()
    .meta({
      description: `How long to hold the call open when nothing is waiting, at most and by default ${LONGEST_WAIT_SECONDS} seconds.`,
    }),
});

export const answerRequestSchema = z.object({
  id: z.coerce.number().int().positive().meta({ description: "The request's id." }),
  options: suggestChecksSchema.shape.options,
});

// A page that asks by itself says so with pressed=false. A form, or a press, asks as a person.
export const requestSuggestionsSchema = z.object({
  pressed: z
    .preprocess(
      (value) => (value === "true" ? true : value === "false" ? false : value),
      z.boolean().optional(),
    )
    .meta({ description: "False when the page asked by itself, without a press." }),
});

/** What an assistant is handed of one request: its id and the ticket's key, title and description. */
export type HandedRequest = { id: number; key: string; title: string; description: string };

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export function createSuggestionRequests(shared: Shared) {
  const { db, prefix, requireRow } = shared;
  const listening = createListening();
  // Which connections were already handed each request, so a request reaches each one once.
  const handed = new Map<number, Set<number>>();

  /** Removes the requests older than KEPT_FOR_MINUTES, and what was remembered of them. */
  function removeOld(): void {
    repository.removeOlderThan(db, isoAgo(KEPT_FOR_MINUTES * 60 * 1000));
    for (const id of handed.keys()) {
      if (repository.findRequest(db, id) === undefined) handed.delete(id);
    }
  }

  /** The time a request must have been made since to still wait for an answer. */
  function openSince(): string {
    return isoAgo(ANSWER_WITHIN_SECONDS * 1000);
  }

  /**
   * Whether a connection that may answer is listening now, and whether one of them takes the
   * requests a page sends by itself. A revoked or expired connection is not counted.
   */
  function availability(): { listening: boolean; automatic: boolean } {
    const heard = listening.listening();
    const live = new Set(
      repository.liveConnectionIds(
        db,
        heard.map((listener) => listener.connectionId),
        new Date().toISOString(),
      ),
    );
    const alive = heard.filter((listener) => live.has(listener.connectionId));
    return {
      listening: alive.length > 0,
      automatic: alive.some((listener) => listener.automatic),
    };
  }

  /** Where this person's latest request on this ticket stands. */
  function stateFor(row: TicketRow, actor: Actor): RequestState {
    const request = repository.latestRequest(db, row.id, actor.id);
    if (request === undefined) return "none";
    if (request.answered_at !== null) return "answered";
    if (request.created_at < openSince() || !wantsCheck(row)) return "expired";
    return "waiting";
  }

  /** The requests waiting that this connection may answer and was not handed yet. */
  function forConnection(connectionId: number, automatic: boolean): HandedRequest[] {
    removeOld();
    const waiting = repository.waitingRequests(db, openSince(), !automatic);
    const found: HandedRequest[] = [];
    for (const request of waiting) {
      const already = handed.get(request.id) ?? new Set<number>();
      if (already.has(connectionId)) continue;
      already.add(connectionId);
      handed.set(request.id, already);
      found.push({
        id: request.id,
        key: buildKey(prefix, request.ticket_id),
        title: request.title,
        description: request.description,
      });
    }
    return found;
  }

  /** The connection's setting, refusing a connection set to Off. */
  function requireSetting(actor: Actor): "when_asked" | "automatic" {
    const setting = suggestionSetting(actor);
    if (setting === "off") {
      throw new HttpError(403, "forbidden", "You are not allowed to do that.");
    }
    return setting;
  }

  return {
    /**
     * The customer who filed a New ticket with no check asks for ways to verify it. pressed is
     * false when their page asked by itself. It is refused, plainly, when no assistant that may
     * answer is listening. A ticket holds one open request: asking again while one waits
     * changes nothing, except that a press makes a page's own request a pressed one.
     */
    requestSuggestions(key: string, input: unknown, actor: Actor): { request: RequestState } {
      const { pressed = true } = parse(requestSuggestionsSchema, input ?? {});
      const state = db.transaction(() => {
        const row = requireRow(key, actor);
        requirePermission(actor, "request_suggestions", row);
        requireNotArchived(key, row);
        if (!wantsCheck(row)) {
          throw new HttpError(
            409,
            "check_exists",
            `Suggestions are only for a New ticket that does not say yet how you will know it is fixed, and ${key} is not one.`,
          );
        }
        removeOld();
        const open = repository.openRequest(db, row.id, openSince());
        if (open !== undefined) {
          if (pressed && open.pressed === 0) repository.markPressed(db, open.id);
          return stateFor(row, actor);
        }
        const available = availability();
        if (pressed ? !available.listening : !available.automatic) {
          throw new HttpError(
            409,
            "no_assistant_listening",
            "No assistant is listening for requests right now. Write how you will know it is fixed yourself, or ask again later.",
          );
        }
        const since = isoAgo(KEPT_FOR_MINUTES * 60 * 1000);
        if (repository.countBy(db, actor.id, since) >= MOST_REQUESTS_PER_PERSON) {
          throw new HttpError(
            429,
            "too_many_requests",
            `You asked for suggestions ${MOST_REQUESTS_PER_PERSON} times in ${KEPT_FOR_MINUTES} minutes, the most there may be. Ask again in a few minutes.`,
          );
        }
        repository.insertRequest(db, {
          ticketId: row.id,
          requestedBy: actor.id,
          pressed,
          now: new Date().toISOString(),
        });
        return stateFor(row, actor);
      })();
      // Every held call looks for a request it may answer.
      listening.wakeAll();
      return { request: state };
    },

    /**
     * What a page reads beside a ticket's suggestions: whether an assistant that may answer is
     * listening, whether one takes the requests a page sends by itself, and where this
     * person's own request on the ticket stands. Only the person who asked reads a request.
     */
    suggestionRequestState(
      key: string,
      actor: Actor,
    ): { available: { listening: boolean; automatic: boolean }; request: RequestState } {
      const row = requireRow(key, actor);
      removeOld();
      return { available: availability(), request: stateFor(row, actor) };
    },

    /**
     * An assistant listens: the call answers as soon as there is a request this connection
     * may answer, with the request's id and the ticket's key, title and description, or with
     * an empty list once wait_seconds have passed. Each request is handed to a connection
     * once. It is the only thing that marks a connection as listening.
     */
    async waitForRequests(actor: Actor, query: unknown): Promise<{ requests: HandedRequest[] }> {
      requirePermission(actor, "wait_for_requests");
      const setting = requireSetting(actor);
      const { wait_seconds = LONGEST_WAIT_SECONDS } = parse(waitForRequestsQuery, query ?? {});
      const deadline = Date.now() + wait_seconds * 1000;
      const call = listening.begin(actor.connection!.id, setting === "automatic");
      try {
        for (;;) {
          const found = forConnection(actor.connection!.id, setting === "automatic");
          if (found.length > 0) return { requests: found };
          const left = deadline - Date.now();
          if (left <= 0) return { requests: [] };
          if ((await call.sleep(left)) === "replaced") return { requests: [] };
        }
      } finally {
        call.end();
      }
    },

    /**
     * An assistant answers a request with one to three ways to verify the ticket. The first
     * answer wins; a second answer, or one after the request expired, is refused. The answer
     * is stored as the ticket's suggestions, exactly as suggest_checks stores them.
     */
    answerRequest(
      input: unknown,
      actor: Actor,
    ): { request_id: number; ticket_key: string; suggestions: CheckSuggestion[] } {
      return db.transaction(() => {
        requirePermission(actor, "answer_request");
        const setting = requireSetting(actor);
        const { id, options } = parse(answerRequestSchema, input ?? {});
        removeOld();
        const request = repository.findRequest(db, id);
        // A request this connection may not answer is not there for it.
        if (request === undefined || (setting === "when_asked" && request.pressed === 0)) {
          throw new HttpError(404, "request_not_found", `No request ${id}.`);
        }
        if (request.answered_at !== null) {
          throw new HttpError(409, "request_closed", `Request ${id} was already answered.`);
        }
        if (request.created_at < openSince()) {
          throw new HttpError(
            409,
            "request_closed",
            `Request ${id} waited more than ${ANSWER_WITHIN_SECONDS} seconds and has expired.`,
          );
        }
        const row = findTicket(db, request.ticket_id)!;
        const key = buildKey(prefix, row.id);
        if (!wantsCheck(row)) {
          throw new HttpError(
            409,
            "request_closed",
            `Ticket ${key} no longer waits for a way to verify it.`,
          );
        }
        repository.markAnswered(db, id, actor.connection!.id, new Date().toISOString());
        return { request_id: id, ...storeSuggestions(db, prefix, row, options, actor.connection!) };
      })();
    },
  };
}

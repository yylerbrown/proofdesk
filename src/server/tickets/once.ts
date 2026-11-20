import { createHash } from "node:crypto";
import type { Actor } from "../actor.js";
import type { Db } from "../db.js";
import { HttpError, ValidationError } from "../errors.js";
import { parseKey } from "./keys.js";
import * as repository from "./repository.js";

/**
 * The retry-safe wrapper around a write, for the JSON API, the MCP tools and the new-ticket form.
 * mayRetry is the ticket service's own check that an actor may still reach a ticket by the
 * door the action uses; it throws the refusal the same write without a key would get.
 */
export function createOnce(
  db: Db,
  prefix: string,
  mayRetry: (key: string, actor: Actor, action: string) => void,
) {
  return {
    /**
     * Runs a write once per idempotency key. A retry with the same key and the same request,
     * while the caller may still reach the ticket, gets the first answer back and changes
     * nothing; the same key with a different request is
     * refused. A refused write stores nothing, so it can be retried with the same key. Without
     * a key, the write simply runs.
     */
    once<T>(
      actor: Actor,
      idempotencyKey: string | undefined,
      action: string,
      ticketKey: string,
      input: unknown,
      write: () => T,
    ): T {
      if (idempotencyKey === undefined) return write();
      if (idempotencyKey.length < 1 || idempotencyKey.length > 100) {
        throw new ValidationError("The idempotency key must be 1 to 100 characters.", {
          idempotency_key: ["Must be 1 to 100 characters."],
        });
      }
      const requestHash = createHash("sha256")
        .update(JSON.stringify([action, ticketKey, input ?? null]))
        .digest("hex");
      return db.transaction(() => {
        const seen = repository.findIdempotency(db, actor.id, idempotencyKey);
        if (seen !== undefined) {
          if (seen.request_hash !== requestHash) {
            throw new HttpError(
              409,
              "idempotency_key_reused",
              "That idempotency key was already used for a different request.",
            );
          }
          // The saved answer is given back only to a caller who may still reach the ticket by
          // the door this action uses.
          // Anyone else gets the refusal the same write without a key would get. A ticket
          // deleted permanently (410, told only to the team) still answers the retry of its
          // own delete with the saved answer.
          if (ticketKey !== "") {
            try {
              mayRetry(ticketKey, actor, action);
            } catch (err) {
              if (!(err instanceof HttpError && err.status === 410)) throw err;
            }
          }
          return JSON.parse(seen.response) as T;
        }
        const result = write();
        // Filing a ticket has no key in its request, but its answer names the new ticket, so
        // the saved answer is tied to it and goes when that ticket is deleted permanently.
        const named = ticketKey !== "" ? ticketKey : (result as { key?: unknown } | null)?.key;
        const ticketId = typeof named === "string" ? parseKey(prefix, named) : null;
        repository.saveIdempotency(db, {
          actor: actor.id,
          key: idempotencyKey,
          action,
          request_hash: requestHash,
          response: JSON.stringify(result),
          ticket_id: ticketId,
          created_at: new Date().toISOString(),
        });
        return result;
      })();
    },
  };
}

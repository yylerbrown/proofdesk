import type { Actor } from "../actor.js";
import { requireDemoSeed } from "../demo.js";
import { forbidden, ValidationError } from "../errors.js";
import { can } from "../permissions.js";
import { parse } from "../validation.js";
import { isDemoAgent } from "./access.js";
import { requireNotArchived, requirePermission, requireRoom } from "./checks.js";
import * as repository from "./repository.js";
import { addEntrySchema, noteSchema, verificationRequestSchema } from "./schemas.js";
import type { Shared } from "./shared.js";
import { THREAD_LIMIT, type TicketEntry } from "./types.js";
import { toEntry } from "./public-fields.js";

// The conversation on a ticket: replies the customer sees, internal notes the team sees, and
// an assistant's request that the owner review its evidence.

export function createConversation(shared: Shared) {
  const { db, budget, requireRow, log } = shared;

  /** Writes a reply or a note, with its purpose and its history entry, together. */
  function writeEntry(
    key: string,
    entry: { kind: "reply" | "note"; body: string; based_on?: number; blocked?: boolean },
    purpose: repository.NotePurpose,
    actor: Actor,
  ): TicketEntry {
    const row = db.transaction(() => {
      const ticket = requireRow(key, actor);
      requirePermission(actor, entry.kind === "note" ? "note" : "reply", ticket);
      requireNotArchived(key, ticket);
      requireRoom(
        () => repository.countRows(db, "ticket_entries", ticket.id),
        budget.entriesPerTicket,
        "replies on this ticket",
      );
      const now = new Date().toISOString();
      // Publishing from a note: it must be a note on this same ticket, published as a reply, by
      // someone who may read notes. Anyone else gets the same refusal whatever the number.
      if (entry.based_on !== undefined) {
        const mayReadNotes = can(actor, "read_notes", ticket);
        const source = repository
          .listEntries(db, ticket.id, true, THREAD_LIMIT)
          .find((e) => e.id === entry.based_on);
        if (
          !mayReadNotes ||
          entry.kind !== "reply" ||
          source === undefined ||
          source.kind !== "note"
        ) {
          throw new ValidationError("A reply can be based only on a note on this ticket.", {
            based_on: ["A reply can be based only on a note on this ticket."],
          });
        }
      }
      const saved = repository.insertEntry(db, {
        ticket_id: ticket.id,
        kind: entry.kind,
        body: entry.body,
        based_on: entry.based_on ?? null,
        // Only an assistant marks its note as blocked; the flag means nothing on anything else.
        blocked: actor.kind === "agent" && entry.kind === "note" && entry.blocked === true ? 1 : 0,
        purpose,
        author: actor.id,
        author_kind: actor.kind,
        author_role: actor.role,
        author_name: actor.name,
        created_at: now,
      });
      log(
        ticket.id,
        actor,
        purpose === "review_request"
          ? "review_requested"
          : entry.kind === "note"
            ? "note_added"
            : "reply_added",
        {},
        now,
      );
      return saved;
    })();
    return toEntry(row);
  }

  /** Writes an assistant's request that the owner review its evidence, as a note of its own kind. */
  function writeReviewRequest(key: string, message: string, actor: Actor): TicketEntry {
    return writeEntry(
      key,
      { kind: "note", body: `Asks the owner to review the evidence: ${message}` },
      "review_request",
      actor,
    );
  }

  return {
    /**
     * Adds a reply or an internal note, and its history entry, together. The history entry
     * says only that something was added. The text itself lives in the entry.
     */
    addEntry(key: string, input: unknown, actor: Actor): TicketEntry {
      // Whether this is a reply or a note is in the input, so the caller must first be allowed
      // at least one of them. writeEntry then checks the one they sent.
      const ticket = requireRow(key, actor);
      if (!can(actor, "reply", ticket) && !can(actor, "note", ticket)) {
        throw forbidden(actor);
      }
      const entry = parse(addEntrySchema, input);
      // Only an assistant's note can be a suggested reply; on anything else the flag means nothing.
      const purpose =
        actor.kind === "agent" && entry.kind === "note" && entry.suggested_reply === true
          ? "suggested_reply"
          : "note";
      return writeEntry(key, entry, purpose, actor);
    },

    /** Adds an internal note from the notes route and tool, checking the input after the caller. */
    addNote(key: string, input: unknown, actor: Actor): TicketEntry {
      requirePermission(actor, "note", requireRow(key, actor));
      const note = parse(noteSchema, input);
      // Only an assistant's note can be a suggested reply; on anything else the flag means nothing.
      const purpose =
        actor.kind === "agent" && note.suggested_reply === true ? "suggested_reply" : "note";
      return writeEntry(
        key,
        { kind: "note", body: note.body, blocked: note.blocked },
        purpose,
        actor,
      );
    },

    /** The API's door to requestReview below, checking the input after the caller. */
    askOwnerToReview(key: string, input: unknown, actor: Actor): TicketEntry {
      requirePermission(actor, "note", requireRow(key, actor));
      const { message } = parse(verificationRequestSchema, input);
      return writeReviewRequest(key, message, actor);
    },

    /**
     * An assistant asks the ticket's owner to review its evidence: an internal note of its own
     * kind, with its own history entry. It never contacts the customer.
     */
    requestReview(key: string, message: string, actor: Actor): TicketEntry {
      return writeReviewRequest(key, message, actor);
    },

    /** The conversation, oldest first. Internal notes only for those who may read them. */
    listEntries(key: string, actor: Actor): TicketEntry[] {
      const row = requireRow(key, actor);
      const includeNotes = can(actor, "read_notes", row);
      // An assistant without note access still reads back the notes it wrote itself: those
      // are its own words, not the team's.
      const ownNotes = actor.kind === "agent" && !includeNotes;
      // Where a reply's words came from is the team's to know: a customer never sees the note.
      const entries = repository
        .listEntries(db, row.id, includeNotes || ownNotes, THREAD_LIMIT)
        .map(toEntry)
        .filter((entry) => !ownNotes || entry.kind !== "note" || entry.author === actor.id)
        .map((entry) => (includeNotes ? entry : { ...entry, based_on: null }));
      if (!isDemoAgent(actor)) return entries;
      const seeded = requireDemoSeed(db).entries;
      return entries.filter((entry) => seeded.includes(entry.id) || entry.author === actor.id);
    },
  };
}

import { createHash } from "node:crypto";
import type { Actor } from "../actor.js";
import { HttpError, ValidationError } from "../errors.js";
import { buildKey } from "../tickets/keys.js";
import type { Shared } from "../tickets/shared.js";
import type { Ticket, TicketEntry } from "../tickets/types.js";
import { pictureTypeOf, type PictureType } from "./kinds.js";
import {
  PICTURE_LIMITS,
  PICTURE_REFUSALS,
  SHOWN_ONLY_TO_UPLOADER,
  type PictureLimits,
} from "./limits.js";
import * as repository from "./repository.js";

// Pictures on tickets. A picture is added with a new ticket's description or with a reply or
// a note, and is seen by exactly the people who see what it is attached to: a picture on an
// internal note is the team's only, and nobody gets a picture from a ticket they cannot open.
//
// On the shared public demo, a visitor's picture is served only to the browser that added it.
// That browser carries a random token in a cookie, and the picture row keeps a hash of it.

/** The pictures sent with one form, as the upload parser read them. */
export type PictureUpload = {
  /** Each picture's bytes, in the order they were sent. */
  files: Buffer[];
  /** The parser's own refusal, such as a picture over the size limit, or null. */
  refused: string | null;
};

export const NO_PICTURES: PictureUpload = { files: [], refused: null };

/** One picture as a page or the API lists it. */
export type PictureView = {
  id: number;
  /** The message it came with, or null for the ticket's own description. */
  entry_id: number | null;
  type: PictureType;
  size: number;
  created_at: string;
  /** Where to load it, or null when this viewer gets no bytes. */
  url: string | null;
  /** The sentence to show in its place when url is null; null when it is shown. */
  hidden: string | null;
};

/** The pictures on one ticket: its description's, and each message's by the message's id. */
export type TicketPictures = {
  description: PictureView[];
  byEntry: Map<number, PictureView[]>;
};

/** What the ticket service already offers that pictures build on. */
type TicketDoors = {
  createTicket: (input: unknown, actor: Actor) => Ticket;
  addEntry: (key: string, input: unknown, actor: Actor) => TicketEntry;
  listEntries: (key: string, actor: Actor) => TicketEntry[];
};

/** The hash a picture row keeps of a demo visitor's token. The token itself is never stored. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A refusal of the pictures, kept beside the form's other messages. */
function refusal(message: string): ValidationError {
  return new ValidationError(message, { pictures: [message] });
}

/** The answer for every picture this viewer may not have, the same as for one that is not there. */
function pictureNotFound(): HttpError {
  return new HttpError(404, "not_found", "There is no picture at this address.");
}

export function createPictures(shared: Shared, tickets: TicketDoors) {
  const { db, prefix, requireRow } = shared;
  const limits: PictureLimits = shared.budget.pictures ?? PICTURE_LIMITS;

  /**
   * Checks the pictures sent with a ticket's description or with one message, then saves them.
   * Call it inside the transaction that wrote what they are attached to, so a refusal undoes
   * that too. uploaderToken is the demo visitor's token, or null on a real site and for the
   * pictures the demo seeds, which everyone may see.
   */
  function attach(
    ticketId: number,
    entryId: number | null,
    upload: PictureUpload,
    actor: Actor,
    uploaderToken: string | null,
  ): void {
    if (upload.refused !== null) throw refusal(upload.refused);
    const files = upload.files;
    if (files.length === 0) return;
    if (files.length > limits.perMessage) throw refusal(PICTURE_REFUSALS.tooManyInMessage(limits));
    const types: PictureType[] = [];
    for (const bytes of files) {
      if (bytes.length > limits.maxBytes) throw refusal(PICTURE_REFUSALS.tooLarge(limits));
      const type = pictureTypeOf(bytes);
      if (type === null) throw refusal(PICTURE_REFUSALS.notAPicture);
      types.push(type);
    }
    if (repository.countTicketPictures(db, ticketId) + files.length > limits.perTicket) {
      throw refusal(PICTURE_REFUSALS.tooManyOnTicket(limits));
    }
    if (
      limits.visitorTotal !== undefined &&
      uploaderToken !== null &&
      repository.countVisitorPictures(db) + files.length > limits.visitorTotal
    ) {
      throw refusal(PICTURE_REFUSALS.demoFull(limits));
    }
    const now = new Date().toISOString();
    files.forEach((bytes, index) => {
      repository.insertPicture(db, {
        ticket_id: ticketId,
        entry_id: entryId,
        added_by: actor.id,
        type: types[index]!,
        size: bytes.length,
        bytes,
        shown_only_to: uploaderToken === null ? null : tokenHash(uploaderToken),
        created_at: now,
      });
    });
  }

  /**
   * The pictures on a ticket that this viewer may see: the description's, and those of each
   * message the viewer can read. viewerToken is the demo visitor's token, or null.
   */
  function visiblePictures(
    key: string,
    actor: Actor,
    viewerToken: string | null,
  ): { ticketId: number; pictures: PictureView[] } {
    const row = requireRow(key, actor);
    const readable = new Set(tickets.listEntries(key, actor).map((entry) => entry.id));
    const viewerHash = viewerToken === null ? null : tokenHash(viewerToken);
    const pictures = repository
      .listPictures(db, row.id)
      .filter((picture) => picture.entry_id === null || readable.has(picture.entry_id))
      .map((picture): PictureView => {
        const shown = picture.shown_only_to === null || picture.shown_only_to === viewerHash;
        return {
          id: picture.id,
          entry_id: picture.entry_id,
          type: picture.type,
          size: picture.size,
          created_at: picture.created_at,
          url: shown ? `/tickets/${buildKey(prefix, row.id)}/pictures/${picture.id}` : null,
          hidden: shown ? null : SHOWN_ONLY_TO_UPLOADER,
        };
      });
    return { ticketId: row.id, pictures };
  }

  return {
    /** The limits pictures are held to on this server, for the forms' hints. */
    pictureLimits: limits,

    /** Files a ticket with the pictures sent with its description, together or not at all. */
    createTicketWithPictures(
      input: unknown,
      upload: PictureUpload,
      actor: Actor,
      uploaderToken: string | null,
    ): Ticket {
      return db.transaction(() => {
        const ticket = tickets.createTicket(input, actor);
        attach(shared.idFromKey(ticket.key), null, upload, actor, uploaderToken);
        return ticket;
      })();
    },

    /** Adds a reply or a note with the pictures sent with it, together or not at all. */
    addEntryWithPictures(
      key: string,
      input: unknown,
      upload: PictureUpload,
      actor: Actor,
      uploaderToken: string | null,
    ): TicketEntry {
      return db.transaction(() => {
        // Who may write, and what they wrote, are checked here first, as for any message.
        const entry = tickets.addEntry(key, input, actor);
        attach(shared.idFromKey(key), entry.id, upload, actor, uploaderToken);
        return entry;
      })();
    },

    /** The pictures on a ticket this viewer may see, split by what they are attached to. */
    listPictures(key: string, actor: Actor, viewerToken: string | null): TicketPictures {
      const { pictures } = visiblePictures(key, actor, viewerToken);
      const byEntry = new Map<number, PictureView[]>();
      for (const picture of pictures) {
        if (picture.entry_id === null) continue;
        byEntry.set(picture.entry_id, [...(byEntry.get(picture.entry_id) ?? []), picture]);
      }
      return {
        description: pictures.filter((picture) => picture.entry_id === null),
        byEntry,
      };
    },

    /**
     * One picture's type and bytes, for a person who may see it. Everything else, a ticket they
     * cannot open included, gets the same answer as a picture that is not there. An assistant
     * sees the list but never the bytes.
     */
    readPicture(
      key: string,
      id: number,
      actor: Actor,
      viewerToken: string | null,
    ): { type: PictureType; bytes: Buffer } {
      if (actor.kind !== "person") throw pictureNotFound();
      let found: { ticketId: number; picture: PictureView | undefined };
      try {
        const { ticketId, pictures } = visiblePictures(key, actor, viewerToken);
        found = { ticketId, picture: pictures.find((picture) => picture.id === id) };
      } catch (err) {
        // A ticket that is not there, not theirs, deleted or misnamed: no picture either.
        if (err instanceof HttpError) throw pictureNotFound();
        throw err;
      }
      const { ticketId, picture } = found;
      if (picture === undefined || picture.url === null) throw pictureNotFound();
      const bytes = repository.pictureBytes(db, ticketId, id);
      if (bytes === undefined) throw pictureNotFound();
      return { type: picture.type, bytes };
    },
  };
}

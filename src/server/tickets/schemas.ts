import { z } from "zod";
import { ValidationError } from "../errors.js";

export const TICKET_STATUSES = ["new", "in_progress", "resolved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// The messages are written for a person, because the ticket form shows them under each box.
export const createTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Must be at least 3 characters.")
    .max(120, "Must be at most 120 characters."),
  description: z
    .string()
    .trim()
    .min(1, "Must not be empty.")
    .max(5000, "Must be at most 5000 characters."),
  where_url: z
    .string()
    .max(500, "Must be at most 500 characters.")
    .pipe(z.url({ protocol: /^https?$/, error: "Must be a link that starts with http or https." }))
    .optional(),
  fix_check: z.string().trim().max(500, "Must be at most 500 characters.").optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

// Permanent deletion is confirmed by typing the ticket's key.
export const deleteTicketSchema = z.object({
  confirm: z.string().trim(),
});

export const ENTRY_KINDS = ["reply", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const addEntrySchema = z.object({
  kind: z.enum(ENTRY_KINDS),
  body: z
    .string()
    .trim()
    .min(1, "Must not be empty.")
    .max(5000, "Must be at most 5000 characters."),
});

// An agent asking the ticket's named owner to request the customer's check.
export const verificationRequestSchema = z.object({
  message: z
    .string()
    .trim()
    .min(1, "Say what was done and what evidence is attached.")
    .max(2000, "Must be at most 2000 characters."),
});

// The agreed version of the check. An empty text removes it, leaving the customer's words.
export const agreeCheckSchema = z.object({
  agreed_check: z.string().trim().max(500, "Must be at most 500 characters."),
});

// A link that must be an http or https address, as for "Where did this happen?".
const httpLink = z
  .string()
  .trim()
  .max(500, "Must be at most 500 characters.")
  .pipe(z.url({ protocol: /^https?$/, error: "Must be a link that starts with http or https." }));

export const linkChangeSchema = z.object({ change_url: httpLink });
export const markReadySchema = z.object({ try_url: httpLink });

// The customer's answer. A "no" needs a comment, which the service checks.
export const answerSchema = z.object({
  fixed: z.enum(["yes", "no"]),
  // The token of the question the customer was shown.
  ready_token: z.string().min(1, "Reload the ticket and answer again."),
  comment: z.string().trim().max(5000, "Must be at most 5000 characters.").optional(),
});

export const changeStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
});

// Which tickets a list shows: one status, every status, or the archived ones.
export const TICKET_LIST_FILTERS = [...TICKET_STATUSES, "all", "archived"] as const;
export type TicketListFilter = (typeof TICKET_LIST_FILTERS)[number];

export const listQuerySchema = z.object({
  status: z.enum(TICKET_LIST_FILTERS).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  cursor: z.string().max(100).optional().meta({
    description: "Where the previous page ended, as given by its next_cursor or Link header.",
  }),
});

/** A cursor names the next page. It is opaque to callers: pass back what you were given. */
export function cursorFor(page: number): string {
  return Buffer.from(JSON.stringify({ page })).toString("base64url");
}

/** The page a cursor names, or a validation error for one that was not made here. */
export function pageOf(cursor: string): number {
  try {
    const { page } = z
      .object({ page: z.number().int().min(1).max(100000) })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return page;
  } catch {
    throw new ValidationError("That cursor was not made here.", {
      cursor: ["Pass back the next_cursor you were given, unchanged."],
    });
  }
}

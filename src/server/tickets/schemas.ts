import { z } from "zod";
import { ValidationError } from "../errors.js";

export const TICKET_STATUSES = ["new", "in_progress", "resolved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// A form sends an empty box for a field left blank; that means it was not given.
const blankIsMissing = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// The messages are written for a person, because the ticket form shows them under each box.
// A link that must be an http or https address, as for "Where did this happen?".
export const httpLink = z
  .string()
  .trim()
  .max(500, "Must be at most 500 characters.")
  .pipe(z.url({ protocol: /^https?$/, error: "Must be a link that starts with http or https." }));

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
  where_url: httpLink.optional(),
  fix_check: z.string().trim().max(500, "Must be at most 500 characters.").optional(),
});

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
  // A reply a person publishes from an internal note: that note's id.
  based_on: z.coerce.number().int().positive().optional(),
  // An assistant's note that says it is blocked. Only an assistant's note is ever marked.
  blocked: z.boolean().optional(),
  // An assistant's note that is wording it suggests the team send to the customer.
  suggested_reply: z.boolean().optional(),
});

// An internal note on its own, for the notes route and tool.
export const noteSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Must not be empty.")
    .max(5000, "Must be at most 5000 characters."),
  blocked: z.boolean().optional().meta({
    description:
      "True when you are blocked: say what blocks you in the note's first line. The team sees it beside the check and in the list until you write an ordinary note again.",
  }),
  suggested_reply: z.boolean().optional().meta({
    description:
      "True when this note is wording you suggest the team send to the customer. A person reads it and decides whether to publish it as their own reply; only such a note is offered for publishing.",
  }),
});

// Handing a ticket to another team member. expected_owner is the owner the form was made for
// (empty for none), so a hand-off from an old page is refused.
export const handOffSchema = z.object({
  to: z.string().min(1, "Choose a team member."),
  expected_owner: z.string().default(""),
});

// The owner hands a ticket to one agent connection, by its id.
export const giveToAgentSchema = z.object({
  connection_id: z.coerce.number().int().positive("Choose a connection."),
});

// The customer says a resolved ticket is still happening, and what recurred.
export const reopenSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, "Give a reason for reopening it.")
    .max(2000, "Must be at most 2000 characters."),
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

export const linkChangeSchema = z.object({ change_url: httpLink });
// Asking the customer "Did this fix it?". Every field is optional, and the customer sees each
// one given: the page to try, what the owner tried there and what happened, what changed since
// the customer's last No, and the evidence relied on. A form sends an empty box for a field left
// blank, and one checkbox as a text and several as a list.
export const markReadySchema = z.object({
  try_url: z.preprocess(blankIsMissing, httpLink.optional()),
  tried: z.preprocess(
    blankIsMissing,
    z.string().trim().max(2000, "Must be at most 2000 characters.").optional(),
  ),
  result: z.preprocess(
    blankIsMissing,
    z.string().trim().max(2000, "Must be at most 2000 characters.").optional(),
  ),
  response: z.preprocess(
    blankIsMissing,
    z.string().trim().max(2000, "Must be at most 2000 characters.").optional(),
  ),
  evidence_ids: z
    .preprocess(
      (value) => (value === undefined || value === "" ? [] : [value].flat()),
      z.array(z.coerce.number().int().positive()),
    )
    .optional(),
});

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
  owner: z.enum(["me", "none"]).optional().meta({
    description: "Narrow to the tickets you own (me) or that nobody owns yet (none).",
  }),
  // A search box sent empty means no search.
  q: z
    .preprocess(
      (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
      z.string().trim().max(100, "Must be at most 100 characters.").optional(),
    )
    .meta({ description: "Words to find in the title or description, in any case." }),
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

/** Why the team resolved a ticket without the customer's Yes. */
export const RESOLVE_REASONS = [
  "fixed_no_reply",
  "duplicate",
  "wont_fix",
  "cannot_reproduce",
  "other",
] as const;
export type ResolveReason = (typeof RESOLVE_REASONS)[number];
export const RESOLVE_REASON_LABELS: Record<ResolveReason, string> = {
  fixed_no_reply: "Fixed, but the customer has not replied",
  duplicate: "Duplicate of another ticket",
  wont_fix: "Won't fix",
  cannot_reproduce: "Cannot reproduce",
  other: "Other",
};

// Resolving by the team: a reason from the list, the other ticket for a duplicate, and a note,
// which "other" needs (checked by the service).
export const resolveSchema = z.object({
  reason: z.enum(RESOLVE_REASONS, { error: "Choose a reason." }),
  note: z.preprocess(
    blankIsMissing,
    z.string().trim().max(500, "Must be at most 500 characters.").optional(),
  ),
  duplicate_of: z.preprocess(
    blankIsMissing,
    z.string().trim().max(20, "Must be a ticket key, such as SUP-3.").optional(),
  ),
});

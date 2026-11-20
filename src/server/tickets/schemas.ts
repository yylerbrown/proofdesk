import { z } from "zod";
import { ValidationError } from "../errors.js";

export const TICKET_STATUSES = ["new", "in_progress", "resolved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// A form sends an empty box for a field left blank; that means it was not given.
export const blankIsMissing = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

// A browser sends each line break in a text box as two characters, "\r\n", while the box's
// maxlength counts it as one. Every text box's words are read with "\n" alone, so a line break
// counts once here too, and each one is stored the same way.
const plainLineBreaks = (text: string) => text.replace(/\r\n?/g, "\n");

export const textBox = () => z.string().overwrite(plainLineBreaks).trim();

// Text stored before line breaks were stored plainly may still hold "\r\n". New words are the
// same as stored words when they match with plain line breaks, so every comparison of new text
// with stored text uses this.
export function sameText(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return plainLineBreaks(a) === plainLineBreaks(b);
}

// The messages are written for a person, because the ticket form shows them under each box.
// A link that must be an http or https address, as for "Where did this happen?".
export const httpLink = z
  .string()
  .trim()
  .max(500, "Must be at most 500 characters.")
  .pipe(z.url({ protocol: /^https?$/, error: "Must be a link that starts with http or https." }));

// The version of the ticket a form or a program last saw (the ticket's "version"). A change sent
// with it is refused, with 409 ticket_changed, when the ticket has changed since, and nothing is
// written. It is optional: a caller that sends none is not checked, as before. A form sends it as
// text, and an empty box means none.
export const expectedVersion = z
  .preprocess(
    // An empty box and a JSON null both mean no version was sent.
    (value) =>
      value === "" || value === null
        ? undefined
        : typeof value === "string"
          ? Number(value)
          : value,
    z
      .number({ error: "Must be the ticket's version, a whole number." })
      .int()
      .positive()
      .optional(),
  )
  .meta({
    description:
      "Optional. The ticket's version as you last read it. If the ticket has changed since, the change is refused with 409 ticket_changed and nothing is written: read it again, then decide. Leave it out to skip the check.",
  });

// For an action whose only input is that version.
export const versionOnlySchema = z.object({ expected_version: expectedVersion });

export const createTicketSchema = z.object({
  title: z
    .string()
    .trim()
    .min(3, "Must be at least 3 characters.")
    .max(120, "Must be at most 120 characters."),
  description: textBox().min(1, "Must not be empty.").max(5000, "Must be at most 5000 characters."),
  where_url: httpLink.optional(),
  fix_check: textBox().max(500, "Must be at most 500 characters.").optional(),
});

// Editing a ticket: the same boxes as a new one, and the version the editor saw.
export const editTicketSchema = createTicketSchema.extend({ expected_version: expectedVersion });

// Permanent deletion is confirmed by typing the ticket's key.
export const deleteTicketSchema = z.object({
  confirm: z.string().trim(),
});

export const ENTRY_KINDS = ["reply", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const addEntrySchema = z.object({
  kind: z.enum(ENTRY_KINDS),
  body: textBox().min(1, "Must not be empty.").max(5000, "Must be at most 5000 characters."),
  // A reply a person publishes from an internal note: that note's id.
  based_on: z.coerce.number().int().positive().optional(),
  // An assistant's note that says it is blocked. Only an assistant's note is ever marked.
  blocked: z.boolean().optional(),
  // An assistant's note that is wording it suggests the team send to the customer.
  suggested_reply: z.boolean().optional(),
});

// An internal note on its own, for the notes route and tool.
export const noteSchema = z.object({
  body: textBox().min(1, "Must not be empty.").max(5000, "Must be at most 5000 characters."),
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
  expected_version: expectedVersion,
});

// The owner hands a ticket to one agent connection, by its id.
export const giveToAgentSchema = z.object({
  connection_id: z.coerce.number().int().positive("Choose a connection."),
  expected_version: expectedVersion,
});

// The customer says a resolved ticket is still happening, and what recurred.
export const reopenSchema = z.object({
  reason: textBox()
    .min(1, "Give a reason for reopening it.")
    .max(2000, "Must be at most 2000 characters."),
  expected_version: expectedVersion,
});

// An agent asking the ticket's named owner to request the customer's check.
export const verificationRequestSchema = z.object({
  message: textBox()
    .min(1, "Say what was done and what evidence is attached.")
    .max(2000, "Must be at most 2000 characters."),
});

// The agreed version of the check. An empty text removes it, leaving the customer's words.
export const agreeCheckSchema = z.object({
  agreed_check: textBox().max(500, "Must be at most 500 characters."),
  expected_version: expectedVersion,
});

export const linkChangeSchema = z.object({
  change_url: httpLink,
  expected_version: expectedVersion,
});

// Asking the customer "Did this fix it?". Every field is optional, and the customer sees each
// one given: the page to try, what the owner tried there and what happened, what changed since
// the customer's last No, and the evidence relied on. A form sends an empty box for a field left
// blank, and one checkbox as a text and several as a list.
export const markReadySchema = z.object({
  try_url: z.preprocess(blankIsMissing, httpLink.optional()),
  tried: z.preprocess(
    blankIsMissing,
    textBox().max(2000, "Must be at most 2000 characters.").optional(),
  ),
  result: z.preprocess(
    blankIsMissing,
    textBox().max(2000, "Must be at most 2000 characters.").optional(),
  ),
  response: z.preprocess(
    blankIsMissing,
    textBox().max(2000, "Must be at most 2000 characters.").optional(),
  ),
  evidence_ids: z
    .preprocess(
      (value) => (value === undefined || value === "" ? [] : [value].flat()),
      z.array(z.coerce.number().int().positive()),
    )
    .optional(),
  expected_version: expectedVersion,
});

// The customer's answer. A "no" needs a comment, which the service checks.
export const answerSchema = z.object({
  fixed: z.enum(["yes", "no"]),
  // The token of the question the customer was shown.
  ready_token: z.string().min(1, "Reload the ticket and answer again."),
  comment: textBox().max(5000, "Must be at most 5000 characters.").optional(),
});

export const changeStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  expected_version: expectedVersion,
});

// Which tickets a list shows: one status, every status, or the archived ones.
export const TICKET_LIST_FILTERS = [...TICKET_STATUSES, "all", "archived"] as const;
export type TicketListFilter = (typeof TICKET_LIST_FILTERS)[number];

/**
 * The orders a list can be read in: open tickets first and newest first, with New tickets that
 * say how to verify the fix ahead of the other open ones (the default), oldest
 * first, or the most recently changed first. The API keeps these words; each is also a sort.
 */
export const LIST_ORDERS = ["open_first", "oldest", "updated"] as const;
export type ListOrder = (typeof LIST_ORDERS)[number];

/** The columns a list can be sorted by. Who a ticket waits on is worked out, not stored. */
export const LIST_SORTS = ["key", "title", "status", "owner", "filed", "updated"] as const;
export type ListSortColumn = (typeof LIST_SORTS)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

/** How a list is sorted: the default (open first, newest first), or one column one way. */
export type ListSort = "open_first" | { by: ListSortColumn; direction: SortDirection };

/**
 * The way each column sorts when it is first chosen without a direction: times newest first,
 * everything else from the start (lowest key, A to Z, New first).
 */
export const FIRST_DIRECTION: Record<ListSortColumn, SortDirection> = {
  key: "asc",
  title: "asc",
  status: "asc",
  owner: "asc",
  filed: "desc",
  updated: "desc",
};

/** The sort each order names. */
export const ORDER_SORTS: Record<ListOrder, ListSort> = {
  open_first: "open_first",
  oldest: { by: "filed", direction: "asc" },
  updated: { by: "updated", direction: "desc" },
};

/**
 * The sort that a column, a direction and an order name together, or undefined when they name
 * none. A column wins over an order, and a direction without a column is not used. The API
 * refuses those two cases before it asks; the page and a cursor take them as they come.
 */
export function sortFrom(
  by: ListSortColumn | undefined,
  direction: SortDirection | undefined,
  order: ListOrder | undefined,
): ListSort | undefined {
  if (by !== undefined) return { by, direction: direction ?? FIRST_DIRECTION[by] };
  if (order !== undefined) return ORDER_SORTS[order];
  return undefined;
}

/** True when two sorts are the same column the same way, or both the default. */
export function sameSort(a: ListSort, b: ListSort): boolean {
  if (a === "open_first" || b === "open_first") return a === b;
  return a.by === b.by && a.direction === b.direction;
}

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
  order: z.enum(LIST_ORDERS).optional().meta({
    description:
      "open_first (the default): New tickets that say how to verify the fix first, then the other open tickets, then resolved ones, each newest first. oldest: oldest first. updated: the most recently changed first. Pages are counted by position, so a ticket that changes while you page through may move onto a page you already read; oldest is the order that never moves. Pass order or sort, not both.",
  }),
  sort: z.enum(LIST_SORTS).optional().meta({
    description:
      "Sort by one column instead: key, title, status (New, In Progress, Resolved), owner (unassigned last), filed or updated. Ties are broken by the key, so pages never repeat or skip a ticket that did not change.",
  }),
  direction: z.enum(SORT_DIRECTIONS).optional().meta({
    description:
      "The way the sort runs, asc or desc. Without it, filed and updated run newest first and the others asc. It needs sort.",
  }),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  cursor: z.string().max(100).optional().meta({
    description:
      "Where the previous page ended, as given by its next_cursor or Link header. It keeps the order it was made for.",
  }),
});

type ListQuery = z.infer<typeof listQuerySchema>;

/** The sort a list query names, or undefined when it names none. */
function requestedSort(query: ListQuery): ListSort | undefined {
  if (query.order !== undefined && query.sort !== undefined) {
    throw new ValidationError("Pass order or sort, not both.", {
      sort: ["Leave out order when you pass sort."],
    });
  }
  if (query.direction !== undefined && query.sort === undefined) {
    throw new ValidationError("A direction needs a sort.", {
      direction: ["Pass sort with direction, or leave direction out."],
    });
  }
  return sortFrom(query.sort, query.direction, query.order);
}

/** A cursor names the next page and its sort. It is opaque to callers: pass back what you were given. */
export function cursorFor(page: number, sort: ListSort): string {
  const named = sort === "open_first" ? { page } : { page, by: sort.by, direction: sort.direction };
  return Buffer.from(JSON.stringify(named)).toString("base64url");
}

/** The page and sort a cursor names, or a validation error for one that was not made here. */
function readCursor(cursor: string): { page: number; sort: ListSort } {
  try {
    const named = z
      .object({
        page: z.number().int().min(1).max(100000),
        // A cursor made before sorts existed may name an order instead, or nothing at all.
        order: z.enum(LIST_ORDERS).default("open_first"),
        by: z.enum(LIST_SORTS).optional(),
        direction: z.enum(SORT_DIRECTIONS).optional(),
      })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    // The order defaults to open_first, so a cursor always names a sort.
    const sort = sortFrom(named.by, named.direction, named.order) ?? "open_first";
    return { page: named.page, sort };
  } catch {
    throw new ValidationError("That cursor was not made here.", {
      cursor: ["Pass back the next_cursor you were given, unchanged."],
    });
  }
}

/**
 * Which page of the list to read, and how it is sorted, from a list query already checked by
 * listQuerySchema. A cursor keeps its own sort, so the next page is read the same way as the
 * one before it. A sort or order that differs from the cursor's is refused, not guessed.
 */
export function listPosition(query: ListQuery): { page: number; sort: ListSort } {
  const asked = requestedSort(query);
  if (query.cursor === undefined) {
    return { page: query.page ?? 1, sort: asked ?? "open_first" };
  }
  const position = readCursor(query.cursor);
  if (asked !== undefined && !sameSort(asked, position.sort)) {
    // Name the field the caller passed: sort, or the older order.
    const field = query.sort !== undefined ? "sort" : "order";
    throw new ValidationError(`That cursor was made for another ${field}.`, {
      [field]: [
        "Leave out order and sort when you pass a cursor, or pass the ones it was made for.",
      ],
    });
  }
  return position;
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
  fixed_no_reply: "Fixed. Not customer-confirmed.",
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
    textBox().max(500, "Must be at most 500 characters.").optional(),
  ),
  duplicate_of: z.preprocess(
    blankIsMissing,
    z.string().trim().max(20, "Must be a ticket key, such as SUP-3.").optional(),
  ),
  expected_version: expectedVersion,
});

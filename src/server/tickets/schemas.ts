import { z } from "zod";

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

export const changeStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
});

// Which tickets a list shows: one status, every status, or the archived ones.
export const TICKET_LIST_FILTERS = [...TICKET_STATUSES, "all", "archived"] as const;
export type TicketListFilter = (typeof TICKET_LIST_FILTERS)[number];

export const listQuerySchema = z.object({
  status: z.enum(TICKET_LIST_FILTERS).optional(),
});

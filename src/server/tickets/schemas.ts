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

export const changeStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
});

export const listQuerySchema = z.object({
  status: z.enum([...TICKET_STATUSES, "all"]).optional(),
});

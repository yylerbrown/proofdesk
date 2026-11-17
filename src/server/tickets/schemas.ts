import { z } from "zod";

export const TICKET_STATUSES = ["new", "in_progress", "resolved"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const createTicketSchema = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(1).max(5000),
  where_url: z
    .string()
    .max(500)
    .pipe(z.url({ protocol: /^https?$/ }))
    .optional(),
  fix_check: z.string().trim().max(500).optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const changeStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
});

export const listQuerySchema = z.object({
  status: z.enum([...TICKET_STATUSES, "all"]).optional(),
});

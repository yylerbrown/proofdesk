import { z } from "zod";
import { listQuerySchema, TICKET_LIST_FILTERS } from "../tickets/schemas.js";

// How the ticket list page reads its address. The JSON API refuses a bad filter with a 400,
// which is right for a program. A person reaches the page from a bookmark, a shared link, a
// role switch or by editing the address, so the page reads what it can and shows the list.
// Anything it cannot read falls back to the plain list instead of an error page.

/** Reads "NEW", " Resolved " and "in-progress" as the filter names the list uses. */
function filterName(value: unknown): unknown {
  return typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, "_")
    : value;
}

const listPageSchema = z.object({
  status: z.preprocess(filterName, z.enum(TICKET_LIST_FILTERS)).catch("all"),
  owner: z.preprocess(filterName, z.enum(["me", "none"]).optional()).catch(undefined),
  q: listQuerySchema.shape.q.catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).catch(1),
});

export type ListPageQuery = z.infer<typeof listPageSchema>;

/** The list page's filters from its address, with anything unreadable left at its default. */
export function readListPageQuery(query: unknown): ListPageQuery {
  return listPageSchema.parse(query ?? {});
}

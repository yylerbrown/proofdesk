import { z } from "zod";
import {
  LIST_ORDERS,
  listQuerySchema,
  TICKET_LIST_FILTERS,
  type ListOrder,
  type TicketListFilter,
} from "../tickets/schemas.js";

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
  order: z.preprocess(filterName, z.enum(LIST_ORDERS)).catch("open_first"),
  page: z.coerce.number().int().min(1).max(100000).catch(1),
});

export type ListPageQuery = z.infer<typeof listPageSchema>;

/** The list page's filters from its address, with anything unreadable left at its default. */
export function readListPageQuery(query: unknown): ListPageQuery {
  return listPageSchema.parse(query ?? {});
}

/** The status tab in the empty-result sentence: "No resolved tickets ...". */
const TAB_WORDS: Record<TicketListFilter, string> = {
  all: "tickets",
  new: "new tickets",
  in_progress: "tickets in progress",
  resolved: "resolved tickets",
  archived: "archived tickets",
};

/**
 * What the list says when the owner filter or the search leaves nothing on this tab, built from
 * what is actually set, and the words of the link that clears it.
 */
export function noMatchWords(
  current: TicketListFilter,
  owner: "me" | "none" | undefined,
  q: string | undefined,
): { sentence: string; clear: string } {
  const whose = owner === "me" ? " that you own" : owner === "none" ? " that nobody owns" : "";
  const found = q === undefined ? "" : ` match "${q}"`;
  // With both set: No new tickets that you own and match "export".
  const joined = whose !== "" && found !== "" ? `${whose} and${found}` : `${whose}${found}`;
  const tickets = TAB_WORDS[current];
  const sentence = `No ${tickets}${joined}.`;
  const clear =
    owner && q !== undefined
      ? "Clear the owner filter and search"
      : owner
        ? "Clear the owner filter"
        : "Clear the search";
  return { sentence, clear };
}

/** The orders the list offers, in the words of its Order links. */
export const LIST_ORDER_LABELS: Record<ListOrder, string> = {
  open_first: "Open first",
  oldest: "Oldest first",
  updated: "Recently updated",
};

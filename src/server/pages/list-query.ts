import { z } from "zod";
import {
  FIRST_DIRECTION,
  LIST_ORDERS,
  LIST_SORTS,
  listQuerySchema,
  SORT_DIRECTIONS,
  sortFrom,
  TICKET_LIST_FILTERS,
  type ListSort,
  type ListSortColumn,
  type SortDirection,
} from "../tickets/schemas.js";

// How the ticket list page reads its address. The JSON API refuses a bad filter with a 400,
// which is right for a program. A person reaches the page from a bookmark, a shared link, a
// role switch or by editing the address, so the page reads what it can and shows the list.
// Anything it cannot read falls back to the plain list instead of an error page.

/**
 * The status links the list page offers: the API's filters and "open", every ticket that is not
 * resolved. The JSON API does not take "open".
 */
export const LIST_PAGE_FILTERS = [...TICKET_LIST_FILTERS, "open"] as const;
export type ListPageFilter = (typeof LIST_PAGE_FILTERS)[number];

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
  status: z.preprocess(filterName, z.enum(LIST_PAGE_FILTERS)).catch("all"),
  owner: z.preprocess(filterName, z.enum(["me", "none"]).optional()).catch(undefined),
  q: listQuerySchema.shape.q.catch(undefined),
  // The orders the list offered before it sorted by its headers, so old links still work.
  order: z.preprocess(filterName, z.enum(LIST_ORDERS).optional()).catch(undefined),
  sort: z.preprocess(filterName, z.enum(LIST_SORTS).optional()).catch(undefined),
  direction: z.preprocess(filterName, z.enum(SORT_DIRECTIONS).optional()).catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).catch(1),
  // Which resolved tickets "Resolved" shows by age. Left out, or anything else, any age.
  resolved: z.preprocess(filterName, z.enum(["recent", "older"]).optional()).catch(undefined),
});

/**
 * Which resolved tickets "Resolved" shows: any age (the default), those resolved in the last 14
 * days, or only those resolved before that.
 */
export type ResolvedAge = "any" | "recent" | "older";

/** The list page's filters and sort, as the route uses them. */
export type ListPageQuery = {
  status: ListPageFilter;
  owner: "me" | "none" | undefined;
  q: string | undefined;
  sort: ListSort;
  page: number;
  resolved: ResolvedAge;
};

/** The list page's filters from its address, with anything unreadable left at its default. */
export function readListPageQuery(query: unknown): ListPageQuery {
  const read = listPageSchema.parse(query ?? {});
  // A column sort wins over an old order link; with neither, the default list.
  const sort: ListSort = sortFrom(read.sort, read.direction, read.order) ?? "open_first";
  return {
    status: read.status,
    owner: read.owner,
    q: read.q,
    sort,
    page: read.page,
    resolved: read.resolved ?? "any",
  };
}

/** How many days a resolved ticket counts as recent after it was resolved. */
export const RECENT_RESOLVED_DAYS = 14;

/**
 * The time that splits recent resolved tickets from older ones under "Resolved": 14 days before
 * now. Only "Resolved" with nothing searched has the filter by age. Every other status link, and
 * a search, finds a ticket whatever its age, so they give undefined.
 */
export function recentResolvedCutoff(
  status: ListPageFilter,
  q: string | undefined,
  now: Date,
): string | undefined {
  if (status !== "resolved" || q !== undefined) return undefined;
  const days = RECENT_RESOLVED_DAYS * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - days).toISOString();
}

/** The status tab in the empty-result sentence: "No resolved tickets ...". */
const TAB_WORDS: Record<ListPageFilter, string> = {
  all: "tickets",
  open: "open tickets",
  new: "new tickets",
  in_progress: "tickets in progress",
  resolved: "resolved tickets",
  archived: "archived tickets",
};

/**
 * What the list says when the owner filter or the search leaves nothing on this tab, built from
 * what is actually set, and the words of the link that clears it. With "Resolved" showing one
 * age only, the sentence names that age, since tickets of the other age may still match.
 */
export function noMatchWords(
  current: ListPageFilter,
  owner: "me" | "none" | undefined,
  q: string | undefined,
  age: ResolvedAge = "any",
): { sentence: string; clear: string } {
  const whose = owner === "me" ? " that you own" : owner === "none" ? " that nobody owns" : "";
  const found = q === undefined ? "" : ` match "${q}"`;
  // With both set: No new tickets that you own and match "export".
  const joined = whose !== "" && found !== "" ? `${whose} and${found}` : `${whose}${found}`;
  const tickets = TAB_WORDS[current];
  // One age only: No tickets that nobody owns were resolved more than 14 days ago.
  const sentence =
    age === "older"
      ? `No tickets${joined} were resolved more than ${RECENT_RESOLVED_DAYS} days ago.`
      : age === "recent"
        ? `No tickets${joined} were resolved in the last ${RECENT_RESOLVED_DAYS} days.`
        : `No ${tickets}${joined}.`;
  const clear =
    owner && q !== undefined
      ? "Clear the owner filter and the search"
      : owner
        ? "Clear the owner filter"
        : "Clear the search";
  return { sentence, clear };
}

/** Each sortable column's header, as the list shows it. */
const SORT_LABELS: Record<ListSortColumn, string> = {
  key: "Key",
  title: "Title",
  status: "Status",
  owner: "Owner",
  filed: "Filed",
  updated: "Updated",
};

/** What each column's sort puts first, in words: "Title, A to Z". */
const DIRECTION_WORDS: Record<ListSortColumn, Record<SortDirection, string>> = {
  key: { asc: "lowest first", desc: "highest first" },
  title: { asc: "A to Z", desc: "Z to A" },
  status: { asc: "New first", desc: "Resolved first" },
  owner: { asc: "A to Z", desc: "Z to A" },
  filed: { asc: "oldest first", desc: "newest first" },
  updated: { asc: "oldest first", desc: "newest first" },
};

/** One column header that sorts: its words, whether it is the sort now, and what a press does. */
export type SortHeader = {
  column: ListSortColumn;
  label: string;
  /** The header cell's aria-sort, only on the column the list is sorted by. */
  ariaSort: "ascending" | "descending" | undefined;
  /** The sort a press on this header gives: this column the other way, or its first way. */
  next: ListSort;
  /** The link's accessible name, saying what the next press does: "Title, sort Z to A". */
  name: string;
};

/**
 * The headers that sort, in the table's order. The time column shows when each ticket was filed,
 * or when it was updated while the list is sorted by that. Who a ticket waits on is worked out
 * from its history and its assistant's notes, not stored, so it does not sort.
 */
export function sortHeaders(sort: ListSort): SortHeader[] {
  const time: ListSortColumn = sort !== "open_first" && sort.by === "updated" ? "updated" : "filed";
  const columns: ListSortColumn[] = ["key", "title", "status", "owner", time];
  return columns.map((column) => {
    const current = sort !== "open_first" && sort.by === column ? sort.direction : undefined;
    const direction =
      current === undefined ? FIRST_DIRECTION[column] : current === "asc" ? "desc" : "asc";
    const label = SORT_LABELS[column];
    return {
      column,
      label,
      ariaSort: current === undefined ? undefined : current === "asc" ? "ascending" : "descending",
      next: { by: column, direction },
      name: `${label}, sort ${DIRECTION_WORDS[column][direction]}`,
    };
  });
}

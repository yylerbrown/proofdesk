import { LIST_PAGE_SIZE } from "../tickets/service.js";

// The line under a long ticket list: the page before, where this page sits, and the page after.
// It is worked out from how many tickets the list holds, so a full last page never offers a
// next page with nothing on it.

/** Where this page sits in the list, and the addresses of the pages either side of it. */
export type ListPages = {
  page: number;
  last: number;
  /** The page before, or null on page one. */
  previous: string | null;
  /** The page after, or null on the last page. */
  next: string | null;
};

/** The last page of a list of this many tickets. An empty list still has page one. */
export function lastPage(total: number): number {
  return Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
}

/**
 * The line under the list for this page of a list of this many tickets, or null when the whole
 * list fits on one page. hrefFor gives the address of a page with the list's own filters.
 */
export function listPages(
  page: number,
  total: number,
  hrefFor: (page: number) => string,
): ListPages | null {
  const last = lastPage(total);
  if (last === 1) return null;
  return {
    page,
    last,
    previous: page > 1 ? hrefFor(page - 1) : null,
    next: page < last ? hrefFor(page + 1) : null,
  };
}

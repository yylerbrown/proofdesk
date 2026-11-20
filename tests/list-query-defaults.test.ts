import { describe, expect, it } from "vitest";
import { lastPage, listPages } from "../src/server/pages/list-pages.js";
import {
  cursorFor,
  listPosition,
  listQuerySchema,
  markReadySchema,
} from "../src/server/tickets/schemas.js";
import { createTicketService, LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// The list's query at its quiet edges: what a query that names nothing falls back to, the
// counts that tell a list where its last page is, and the line of pages worked out from them.

describe("a list query that names nothing", () => {
  it("reads page one in the default order", () => {
    expect(listPosition(listQuerySchema.parse({}))).toEqual({ page: 1, sort: "open_first" });
  });

  it("takes an older order by its column sort", () => {
    expect(listPosition(listQuerySchema.parse({ order: "oldest", page: "3" }))).toEqual({
      page: 3,
      sort: { by: "filed", direction: "asc" },
    });
  });

  it("gives a column sort its first direction when none is named", () => {
    expect(listPosition(listQuerySchema.parse({ sort: "updated" })).sort).toEqual({
      by: "updated",
      direction: "desc",
    });
    expect(listPosition(listQuerySchema.parse({ sort: "title" })).sort).toEqual({
      by: "title",
      direction: "asc",
    });
  });

  it.each([
    ["an empty search", { q: "" }],
    ["a search of spaces", { q: "   " }],
    ["no search", {}],
  ])("reads %s as no search", (_name, query) => {
    expect(listQuerySchema.parse(query).q).toBeUndefined();
  });

  it("keeps the default order across a cursor made for it", () => {
    const cursor = cursorFor(2, "open_first");
    expect(listPosition(listQuerySchema.parse({ cursor, order: "open_first" }))).toEqual({
      page: 2,
      sort: "open_first",
    });
  });

  it("refuses a column sort with a cursor made for the default order", () => {
    const cursor = cursorFor(2, "open_first");
    expect(() => listPosition(listQuerySchema.parse({ cursor, sort: "title" }))).toThrow(
      expect.objectContaining({
        status: 400,
        fieldErrors: expect.objectContaining({ sort: expect.any(Array) }),
      }),
    );
  });
});

describe("the evidence a ready-for-review form names", () => {
  it.each([
    ["nothing", {}, []],
    ["an empty box", { evidence_ids: "" }, []],
    ["one box", { evidence_ids: "3" }, [3]],
    ["several boxes", { evidence_ids: ["3", "5"] }, [3, 5]],
  ])("is a list when the form sends %s", (_name, form, ids) => {
    const parsed = markReadySchema.parse(form);
    expect(parsed.evidence_ids ?? []).toEqual(ids);
  });
});

/** A service on a fresh database, with tickets filed by two customers. */
function filed() {
  const { db, config } = buildTestApp();
  const service = createTicketService(db, config.ticketPrefix);
  for (let i = 1; i <= 3; i++) {
    service.createTicket({ title: `Export fails ${i}`, description: "d" }, customerOne);
  }
  service.createTicket({ title: "Import slow", description: "d" }, customerTwo);
  return { db, service };
}

describe("how many tickets a list pages through", () => {
  it("counts each filter the list offers", () => {
    const { db, service } = filed();
    db.prepare(
      "UPDATE tickets SET status = 'in_progress', owner_id = 'dev-team-1', owner_name = 'Team One' WHERE id = 2",
    ).run();
    db.prepare("UPDATE tickets SET status = 'resolved' WHERE id = 3").run();
    expect(service.countListed("all", teamActor)).toBe(4);
    expect(service.countListed("open", teamActor)).toBe(3);
    expect(service.countListed("new", teamActor)).toBe(2);
    expect(service.countListed("in_progress", teamActor)).toBe(1);
    expect(service.countListed("resolved", teamActor)).toBe(1);
  });

  it("counts only a customer's own tickets, with the search", () => {
    const { service } = filed();
    expect(service.countListed("all", customerOne)).toBe(3);
    expect(service.countListed("all", customerTwo)).toBe(1);
    expect(service.countListed("all", teamActor, { q: "import" })).toBe(1);
  });

  it("counts archived tickets only under archived, and only for the team", () => {
    const { db, service } = filed();
    db.prepare("UPDATE tickets SET archived_at = '2026-01-01T00:00:00.000Z' WHERE id = 1").run();
    expect(service.countListed("all", teamActor)).toBe(3);
    expect(service.countListed("archived", teamActor)).toBe(1);
    expect(() => service.countListed("archived", customerOne)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });

  it("counts the resolved tickets before a time", () => {
    const { db, service } = filed();
    db.prepare(
      "UPDATE tickets SET status = 'resolved', last_resolved_at = '2026-01-01T00:00:00.000Z' WHERE id IN (1, 4)",
    ).run();
    db.prepare(
      "UPDATE tickets SET status = 'resolved', last_resolved_at = '2026-06-01T00:00:00.000Z' WHERE id = 2",
    ).run();
    expect(service.countResolvedBefore(teamActor, {}, "2026-03-01T00:00:00.000Z")).toBe(2);
    expect(service.countResolvedBefore(customerOne, {}, "2026-03-01T00:00:00.000Z")).toBe(1);
  });
});

describe("the line of pages", () => {
  const href = (page: number) => `/tickets?page=${page}`;

  it.each([
    [0, 1],
    [1, 1],
    [LIST_PAGE_SIZE, 1],
    [LIST_PAGE_SIZE + 1, 2],
    [LIST_PAGE_SIZE * 2, 2],
  ])("puts the last page of %i tickets at %i", (total, last) => {
    expect(lastPage(total)).toBe(last);
  });

  it("is not drawn when the list fits on one page", () => {
    expect(listPages(1, LIST_PAGE_SIZE, href)).toBeNull();
  });

  it("offers no page before page one and no page after the last", () => {
    const total = LIST_PAGE_SIZE * 2 + 1;
    expect(listPages(1, total, href)).toEqual({
      page: 1,
      last: 3,
      previous: null,
      next: "/tickets?page=2",
    });
    expect(listPages(2, total, href)).toEqual({
      page: 2,
      last: 3,
      previous: "/tickets?page=1",
      next: "/tickets?page=3",
    });
    expect(listPages(3, total, href)).toEqual({
      page: 3,
      last: 3,
      previous: "/tickets?page=2",
      next: null,
    });
  });
});

describe("the older ticket that may report the same problem", () => {
  it("ignores a ticket to skip that is not a ticket key", () => {
    const { service } = filed();
    const found = service.possibleDuplicate("SUP-2", teamActor, ["not-a-key", "SUP-99x"]);
    expect(found?.key).toBe("SUP-1");
  });

  it("skips the tickets it is told to skip", () => {
    const { service } = filed();
    expect(service.possibleDuplicate("SUP-2", teamActor, ["SUP-1"])).toBeNull();
  });
});

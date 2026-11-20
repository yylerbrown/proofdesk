import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { as, buildTestApp, teamActor } from "./helpers.js";

// The ticket list page shows one page of tickets at a time and links to the next. The second
// page keeps the sort chosen by a column header, so it goes on where the first page stopped.

type Built = ReturnType<typeof buildTestApp>;

/** Puts this many open tickets straight into the table, numbered 1 to count. */
function fill(db: Built["db"], count: number): void {
  const insert = db.prepare(
    `INSERT INTO tickets (title, description, status, created_by, created_at, updated_at)
     VALUES (?, 'd', 'new', 'dev-customer-1', ?, ?)`,
  );
  for (let i = 1; i <= count; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    insert.run(`Ticket ${i}`, at, at);
  }
}

/** The ticket keys in the page's table, top to bottom, and its "Next page" link, if any. */
function readPage(html: string): { keys: string[]; next: string | null } {
  const page = parse(html);
  const keys = page
    .querySelectorAll("table.tickets tbody tr td:first-child")
    .map((cell) => cell.text.trim());
  const link = page.querySelectorAll("a").find((a) => a.text.trim() === "Next page");
  return { keys, next: link?.getAttribute("href") ?? null };
}

describe("page two of the ticket list", () => {
  it("goes on in the sort chosen by a column header, and ends there", async () => {
    const built = buildTestApp();
    const extra = 30;
    const total = LIST_PAGE_SIZE + extra;
    fill(built.db, total);
    const team = as(built.app, teamActor);

    const first = await team.get("/tickets?sort=key&direction=asc");
    expect(first.status).toBe(200);
    const one = readPage(first.text);
    expect(one.keys).toHaveLength(LIST_PAGE_SIZE);
    expect(one.keys[0]).toBe("SUP-1");
    expect(one.next).not.toBeNull();

    const second = await team.get(one.next!);
    expect(second.status).toBe(200);
    const two = readPage(second.text);
    // Lowest number first, carrying on from the first page. Without the sort, page two would
    // list the oldest tickets in the list's usual newest-first order instead.
    const expected = Array.from({ length: extra }, (_, i) => `SUP-${LIST_PAGE_SIZE + 1 + i}`);
    expect(two.keys).toEqual(expected);
    expect(two.next).toBeNull();
  });
});

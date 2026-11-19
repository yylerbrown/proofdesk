import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";
import * as repository from "../src/server/tickets/repository.js";
import { ORDER_SORTS } from "../src/server/tickets/schemas.js";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { as, buildTestApp, teamActor } from "./helpers.js";

// The API's list orders: open first and newest first (the default), oldest first, or recently
// updated, kept in the API's cursor. The page sorts by its column headers instead. Each order reads one page at a time from
// an index, so a long list never sorts the whole table.

type Built = ReturnType<typeof buildTestApp>;

/**
 * Puts more than a page of tickets straight into the table: every third one resolved, and each
 * updated at a time that does not follow its id, so the three orders differ.
 */
function fill(db: Built["db"], count = LIST_PAGE_SIZE + 30): void {
  const insert = db.prepare(
    `INSERT INTO tickets (title, description, status, created_by, created_at, updated_at)
     VALUES (?, 'd', ?, 'dev-customer-1', ?, ?)`,
  );
  for (let i = 1; i <= count; i++) {
    const created = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    const updated = new Date(Date.UTC(2026, 1, 1, 0, (i * 37) % count)).toISOString();
    insert.run(`Ticket ${i}`, i % 3 === 0 ? "resolved" : "new", created, updated);
  }
}

type Row = { key: string; status: string; updated_at: string };

/** Every ticket the API lists in this order, following its Link header page by page. */
async function everyPage(built: Built, order?: string): Promise<{ rows: Row[]; pages: number }> {
  let address: string | null = order ? `/api/tickets?order=${order}` : "/api/tickets";
  const rows: Row[] = [];
  let pages = 0;
  while (address !== null) {
    const res = await as(built.app, teamActor).get(address);
    expect(res.status, res.text).toBe(200);
    rows.push(...(res.body as Row[]));
    pages += 1;
    const next = /<([^>]+)>; rel="next"/.exec(String(res.headers.link ?? ""));
    address = next ? next[1]! : null;
  }
  return { rows, pages };
}

const id = (row: Row) => Number(row.key.split("-")[1]);

describe("each order the list offers", () => {
  it.each([
    [
      "open_first",
      (a: Row, b: Row) =>
        Number(a.status === "resolved") - Number(b.status === "resolved") || id(b) - id(a),
    ],
    ["oldest", (a: Row, b: Row) => id(a) - id(b)],
    ["updated", (a: Row, b: Row) => b.updated_at.localeCompare(a.updated_at) || id(b) - id(a)],
  ] as const)(
    "%s returns every ticket once, in the promised sequence, across a page boundary",
    async (order, compare) => {
      const built = buildTestApp();
      fill(built.db);
      const { rows, pages } = await everyPage(built, order);
      expect(pages).toBe(2);
      expect(new Set(rows.map((row) => row.key)).size).toBe(LIST_PAGE_SIZE + 30);
      expect(rows).toEqual([...rows].sort(compare));
    },
  );

  it("keeps the order in the cursor, so the next page is read the same way", async () => {
    const built = buildTestApp();
    fill(built.db);
    const first = await as(built.app, teamActor).get("/api/tickets?order=oldest");
    const cursor = /cursor=([^&>]+)/.exec(String(first.headers.link))![1]!;
    // The cursor alone carries on in the oldest-first order.
    const next = await as(built.app, teamActor).get(`/api/tickets?cursor=${cursor}`);
    expect((next.body as Row[])[0]!.key).toBe(`SUP-${LIST_PAGE_SIZE + 1}`);
    // A different order beside that cursor is refused, not guessed.
    const mixed = await as(built.app, teamActor).get(`/api/tickets?cursor=${cursor}&order=updated`);
    expect(mixed.status).toBe(400);
  });

  it("refuses an unknown order in the API, and shows the plain list on the page", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const api = await as(built.app, teamActor).get("/api/tickets?order=sideways");
    expect(api.status).toBe(400);
    expect(api.body.error.fields.order).toBeDefined();
    const page = await as(built.app, teamActor).get("/tickets?order=sideways");
    expect(page.status).toBe(200);
    const keys = parse(page.text)
      .querySelectorAll("table.tickets tbody tr td:first-child")
      .map((td) => td.text);
    // Open first, newest first, then the resolved one.
    expect(keys).toEqual(["SUP-5", "SUP-4", "SUP-2", "SUP-1", "SUP-3"]);
  });

  it("is described in the API's OpenAPI document, from the action table", async () => {
    const { app } = buildTestApp();
    const doc = (await as(app, teamActor).get("/api/openapi.json")).body;
    const list = doc.paths["/tickets"].get;
    const order = list.parameters.find((p: { name: string }) => p.name === "order");
    expect(order.schema.enum).toEqual(["open_first", "oldest", "updated"]);
    // Pages are counted by position, so the description warns that a changed ticket can move.
    expect(order.description).toContain("may move onto a page you already read");
  });
});

describe("how the team's list reads the table", () => {
  it.each(["open_first", "oldest", "updated"] as const)(
    "%s reads in index order, with no sort of the whole table",
    (order) => {
      const built = buildTestApp();
      fill(built.db);
      const spy = vi.spyOn(built.db, "prepare");
      const page = { limit: LIST_PAGE_SIZE, offset: 0 };
      repository.listTickets(built.db, { kind: "everyone" }, null, ORDER_SORTS[order], page);
      const sql = String(spy.mock.calls.at(-1)![0]);
      spy.mockRestore();
      const values = { status: null, ownerId: null, unassigned: 0, search: null, ...page };
      const steps = (
        built.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(values) as { detail: string }[]
      ).map((row) => row.detail);
      expect(steps.join(" | ")).not.toContain("TEMP B-TREE");
    },
  );
});

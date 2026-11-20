import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";
import * as repository from "../src/server/tickets/repository.js";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// In the default list order, New tickets that say how to verify the fix come before the other
// open tickets, so a customer who fills in the check gets looked at sooner. In Progress and
// Resolved tickets keep the order they had. A pressed column header sorts exactly as before.

type Built = ReturnType<typeof buildTestApp>;
type Row = { key: string; status: string; fix_check: string | null };

/** Puts one ticket straight into the table, filed by the first customer. */
function insert(db: Built["db"], status: string, fixCheck: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tickets
       (title, description, status, fix_check, created_by, created_at, updated_at, last_resolved_at)
     VALUES ('A ticket', 'd', ?, ?, 'dev-customer-1', @now, @now, ?)`,
  ).run(status, fixCheck, status === "resolved" ? now : null, { now });
}

/** The keys the API lists on its first page, at this address. */
async function apiKeys(built: Built, address = "/api/tickets"): Promise<string[]> {
  const res = await as(built.app, teamActor).get(address);
  expect(res.status, res.text).toBe(200);
  return (res.body as Row[]).map((row) => row.key);
}

/** The keys a person sees in the list page's table, top to bottom. */
async function pageKeys(built: Built, who = teamActor, address = "/tickets"): Promise<string[]> {
  const res = await as(built.app, who).get(address);
  expect(res.status, res.text).toBe(200);
  return parse(res.text)
    .querySelectorAll("table.tickets tbody tr td:first-child")
    .map((td) => td.text.trim());
}

/** Files three New tickets through the API: without a check, with one, without one. */
async function fileThree(built: Built): Promise<void> {
  const checks = [undefined, "The export holds every row", undefined];
  for (const check of checks) {
    const res = await as(built.app, customerOne)
      .post("/api/tickets")
      .send({ title: "Export is empty", description: "No rows.", fix_check: check });
    expect(res.status, res.text).toBe(201);
  }
}

describe("the default order puts New tickets that say how to verify first", () => {
  it("lists the one with a check first, then the others newest first", async () => {
    const built = buildTestApp();
    await fileThree(built);
    const expected = ["SUP-2", "SUP-3", "SUP-1"];
    expect(await apiKeys(built)).toEqual(expected);
    expect(await pageKeys(built)).toEqual(expected);
    // The customer's own list reads the same query.
    expect(await pageKeys(built, customerOne)).toEqual(expected);
  });

  it("moves an older New ticket up once a check is added to it", async () => {
    const built = buildTestApp();
    await fileThree(built);
    const res = await as(built.app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ words: "The export holds every row" });
    expect(res.status, res.text).toBe(200);
    expect(await apiKeys(built)).toEqual(["SUP-2", "SUP-1", "SUP-3"]);
  });

  it("leaves In Progress and Resolved tickets where they were", async () => {
    const built = buildTestApp();
    insert(built.db, "new", "It works"); // SUP-1
    insert(built.db, "in_progress", "It works"); // SUP-2: a check does not lift it
    insert(built.db, "new", null); // SUP-3
    insert(built.db, "resolved", "It works"); // SUP-4
    insert(built.db, "new", "It works"); // SUP-5
    insert(built.db, "in_progress", null); // SUP-6
    // New with a check, newest first; then the other open ones newest first, as before; then
    // the resolved ones.
    expect(await apiKeys(built)).toEqual(["SUP-5", "SUP-1", "SUP-6", "SUP-3", "SUP-2", "SUP-4"]);
  });

  it("does not apply once a column header is pressed", async () => {
    const built = buildTestApp();
    await fileThree(built);
    expect(await pageKeys(built, teamActor, "/tickets?sort=key&direction=desc")).toEqual([
      "SUP-3",
      "SUP-2",
      "SUP-1",
    ]);
    expect(await apiKeys(built, "/api/tickets?sort=key&direction=asc")).toEqual([
      "SUP-1",
      "SUP-2",
      "SUP-3",
    ]);
  });

  it("pages across the boundary with no ticket repeated or lost", async () => {
    const built = buildTestApp();
    const count = LIST_PAGE_SIZE + 30;
    for (let i = 1; i <= count; i++) {
      const status = i % 5 === 0 ? "resolved" : i % 7 === 0 ? "in_progress" : "new";
      insert(built.db, status, i % 3 === 0 ? "It works" : null);
    }
    let address: string | null = "/api/tickets";
    const rows: Row[] = [];
    while (address !== null) {
      const res = await as(built.app, teamActor).get(address);
      expect(res.status, res.text).toBe(200);
      rows.push(...(res.body as Row[]));
      const next = /<([^>]+)>; rel="next"/.exec(String(res.headers.link ?? ""));
      address = next ? next[1]! : null;
    }
    expect(new Set(rows.map((row) => row.key)).size).toBe(count);
    const id = (row: Row) => Number(row.key.split("-")[1]);
    const first = (row: Row) => (row.status === "new" && row.fix_check !== null ? 0 : 1);
    const resolved = (row: Row) => Number(row.status === "resolved");
    const promised = [...rows].sort(
      (a, b) => resolved(a) - resolved(b) || first(a) - first(b) || id(b) - id(a),
    );
    expect(rows).toEqual(promised);
  });

  it("reads the table through its own index, with no sort of the whole table", () => {
    const built = buildTestApp();
    insert(built.db, "new", "It works");
    const spy = vi.spyOn(built.db, "prepare");
    const page = { limit: LIST_PAGE_SIZE, offset: 0 };
    repository.listTickets(built.db, { kind: "everyone" }, null, "open_first", page);
    const sql = String(spy.mock.calls.at(-1)![0]);
    spy.mockRestore();
    const values = {
      status: null,
      ownerId: null,
      unassigned: 0,
      search: null,
      match: null,
      resolvedSince: null,
      ...page,
    };
    const plan = (built.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(values) as { detail: string }[])
      .map((row) => row.detail)
      .join(" | ");
    expect(plan).toContain("tickets_list_verifiable_first");
    expect(plan).not.toContain("TEMP B-TREE");
  });
});

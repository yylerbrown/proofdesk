import { parse } from "node-html-parser";
import { describe, expect, it, vi } from "vitest";
import * as repository from "../src/server/tickets/repository.js";
import {
  LIST_SORTS,
  SORT_DIRECTIONS,
  sortFrom,
  type ListSortColumn,
  type SortDirection,
} from "../src/server/tickets/schemas.js";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// The ticket list sorts by its column headers: one press sorts by that column, a second press
// reverses it. The sort sits in the address beside the filters, and the API takes the same
// sort and direction. Each sort ends on the key, so pages never repeat or skip a ticket.

type Built = ReturnType<typeof buildTestApp>;

const COUNT = LIST_PAGE_SIZE + 30;

// Titles that repeat in different cases, so the title sort ignores case and needs its tie-breaker.
const TITLES = ["alpha", "Bravo", "charlie", "Alpha", "delta"];
// Owners in mixed case, and tickets nobody owns.
const OWNERS: (string | null)[] = [null, "Team One", "ann", "Bob"];
const STATUSES = ["new", "in_progress", "resolved"];

/**
 * Puts more than a page of tickets straight into the table, each filed and updated at a time
 * that does not follow its id, so every column sorts differently from the key.
 */
function fill(db: Built["db"], count = COUNT, filedBy = "dev-customer-1"): void {
  const insert = db.prepare(
    `INSERT INTO tickets
       (title, description, status, created_by, owner_id, owner_name, created_at, updated_at)
     VALUES (?, 'd', ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 1; i <= count; i++) {
    const owner = OWNERS[i % OWNERS.length]!;
    const filed = new Date(Date.UTC(2026, 0, 1, 0, (i * 53) % count)).toISOString();
    const updated = new Date(Date.UTC(2026, 1, 1, 0, (i * 37) % count)).toISOString();
    insert.run(
      `${TITLES[i % TITLES.length]} ${i % 2 === 0 ? "export" : "import"}`,
      owner === null ? "new" : STATUSES[i % STATUSES.length],
      filedBy,
      owner === null ? null : `owner-${owner}`,
      owner,
      filed,
      updated,
    );
  }
}

type Row = {
  key: string;
  title: string;
  status: string;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
};

const id = (row: Row) => Number(row.key.split("-")[1]);
const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const RANK: Record<string, number> = { new: 0, in_progress: 1, resolved: 2 };

/** The promised sequence of each column from its start, ties broken by the key. */
const ASCENDING: Record<ListSortColumn, (a: Row, b: Row) => number> = {
  key: (a, b) => id(a) - id(b),
  title: (a, b) => text(a.title.toLowerCase(), b.title.toLowerCase()) || id(a) - id(b),
  status: (a, b) => RANK[a.status]! - RANK[b.status]! || id(a) - id(b),
  owner: (a, b) =>
    Number(a.owner_name === null) - Number(b.owner_name === null) ||
    text((a.owner_name ?? "").toLowerCase(), (b.owner_name ?? "").toLowerCase()) ||
    id(a) - id(b),
  filed: (a, b) => text(a.created_at, b.created_at) || id(a) - id(b),
  updated: (a, b) => text(a.updated_at, b.updated_at) || id(a) - id(b),
};

function promised(column: ListSortColumn, direction: SortDirection) {
  const ascending = ASCENDING[column];
  return direction === "asc" ? ascending : (a: Row, b: Row) => ascending(b, a);
}

/** Every ticket the API lists from this address, following its Link header page by page. */
async function everyApiPage(built: Built, first: string, who = teamActor) {
  let address: string | null = first;
  const rows: Row[] = [];
  let pages = 0;
  while (address !== null) {
    const res = await as(built.app, who).get(address);
    expect(res.status, res.text).toBe(200);
    rows.push(...(res.body as Row[]));
    pages += 1;
    const next = /<([^>]+)>; rel="next"/.exec(String(res.headers.link ?? ""));
    address = next ? next[1]! : null;
  }
  return { rows, pages };
}

/** The keys the list page shows from this address, following its "Next page" link. */
async function everyListPage(built: Built, first: string): Promise<string[]> {
  let address: string | null = first;
  const keys: string[] = [];
  while (address !== null) {
    const res = await as(built.app, teamActor).get(address);
    expect(res.status).toBe(200);
    const html = parse(res.text);
    keys.push(
      ...html.querySelectorAll("table.tickets tbody tr td:first-child").map((td) => td.text),
    );
    const next = html.querySelectorAll("a").find((a) => a.text === "Next page");
    address = next ? next.getAttribute("href")! : null;
  }
  return keys;
}

const EVERY_SORT = LIST_SORTS.flatMap((column) =>
  SORT_DIRECTIONS.map((direction) => [column, direction] as const),
);

describe("each column sorts both ways", () => {
  it.each(EVERY_SORT)(
    "%s %s lists every ticket once, in the promised sequence, across a page boundary",
    async (column, direction) => {
      const built = buildTestApp();
      fill(built.db);
      const address = `/api/tickets?sort=${column}&direction=${direction}`;
      const { rows, pages } = await everyApiPage(built, address);
      expect(pages).toBe(2);
      expect(new Set(rows.map((row) => row.key)).size).toBe(COUNT);
      expect(rows).toEqual([...rows].sort(promised(column, direction)));
      // The page shows the same sequence, page after page.
      const keys = await everyListPage(built, `/tickets?sort=${column}&direction=${direction}`);
      expect(keys).toEqual(rows.map((row) => row.key));
    },
  );
});

describe("the list's column headers", () => {
  const headers = (html: ReturnType<typeof parse>) =>
    html.querySelectorAll("table.tickets thead th").map((th) => {
      const link = th.querySelector("a");
      return {
        text: link?.text ?? th.text,
        sort: th.getAttribute("aria-sort") ?? null,
        name: link?.getAttribute("aria-label") ?? null,
        href: link?.getAttribute("href") ?? null,
      };
    });

  it("are links that say what a press does, with no column marked sorted by default", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const html = parse((await as(built.app, teamActor).get("/tickets")).text);
    expect(headers(html)).toEqual([
      {
        text: "Key",
        sort: null,
        name: "Key, sort lowest first",
        href: "/tickets?sort=key&direction=asc",
      },
      {
        text: "Title",
        sort: null,
        name: "Title, sort A to Z",
        href: "/tickets?sort=title&direction=asc",
      },
      {
        text: "Status",
        sort: null,
        name: "Status, sort New first",
        href: "/tickets?sort=status&direction=asc",
      },
      {
        text: "Owner",
        sort: null,
        name: "Owner, sort A to Z",
        href: "/tickets?sort=owner&direction=asc",
      },
      {
        text: "Filed",
        sort: null,
        name: "Filed, sort newest first",
        href: "/tickets?sort=filed&direction=desc",
      },
    ]);
    // Each sortable header also holds its name as plain words, which stand in for the link on a
    // phone, where the header row is not drawn and a link there would be a stop nobody sees.
    const plain = html
      .querySelectorAll("table.tickets thead th")
      .map((th) => th.querySelector("span.sort-label")?.text ?? null);
    expect(plain).toEqual(["Key", "Title", "Status", "Owner", "Filed"]);
    // The default list is open first, newest first, as before.
    const keys = html
      .querySelectorAll("table.tickets tbody tr td:first-child")
      .map((td) => td.text);
    expect(keys).toEqual(["SUP-4", "SUP-3", "SUP-1", "SUP-5", "SUP-2"]);
  });

  it("mark the sorted column and reverse it on a second press", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const first = parse(
      (await as(built.app, teamActor).get("/tickets?sort=title&direction=asc")).text,
    );
    const title = headers(first)[1]!;
    expect(title.sort).toBe("ascending");
    expect(title.text).toBe("Title↑");
    expect(title.name).toBe("Title, sort Z to A");
    expect(title.href).toBe("/tickets?sort=title&direction=desc");
    // Only the sorted column carries aria-sort.
    expect(headers(first).filter((header) => header.sort !== null)).toHaveLength(1);

    const second = parse((await as(built.app, teamActor).get(title.href!)).text);
    expect(headers(second)[1]!.sort).toBe("descending");
    expect(headers(second)[1]!.text).toBe("Title↓");
    expect(headers(second)[1]!.href).toBe("/tickets?sort=title&direction=asc");
  });

  it("show the time updated while the list is sorted by it, as an old order link asks", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const html = parse((await as(built.app, teamActor).get("/tickets?order=updated")).text);
    const time = headers(html).at(-1)!;
    expect(time.text).toBe("Updated↓");
    expect(time.sort).toBe("descending");
    // The old oldest-first link is the filed column from the start.
    const oldest = parse((await as(built.app, teamActor).get("/tickets?order=oldest")).text);
    expect(headers(oldest).at(-1)).toMatchObject({ text: "Filed↑", sort: "ascending" });
  });

  it("keep the filters and the search, and the filters and the search keep the sort", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const html = parse(
      (await as(built.app, teamActor).get("/tickets?status=new&owner=none&q=export&sort=owner"))
        .text,
    );
    const owner = headers(html)[3]!;
    expect(owner.sort).toBe("ascending");
    expect(owner.href).toBe("/tickets?status=new&owner=none&q=export&sort=owner&direction=desc");
    expect(headers(html)[0]!.href).toBe(
      "/tickets?status=new&owner=none&q=export&sort=key&direction=asc",
    );
    const resolved = html
      .querySelectorAll("nav[aria-label='Filter by status'] a")
      .find((a) => a.text.startsWith("Resolved"))!;
    expect(resolved.getAttribute("href")).toBe(
      "/tickets?status=resolved&owner=none&q=export&sort=owner&direction=asc",
    );
    const mine = html
      .querySelectorAll("nav[aria-label='Filter by owner'] a")
      .find((a) => a.text === "Mine")!;
    expect(mine.getAttribute("href")).toBe(
      "/tickets?status=new&owner=me&q=export&sort=owner&direction=asc",
    );
    const search = html.querySelector("form.list-search")!;
    expect(search.querySelector("input[name=sort]")?.getAttribute("value")).toBe("owner");
    expect(search.querySelector("input[name=direction]")?.getAttribute("value")).toBe("asc");
  });

  it("are offered again above the list for a phone, where some columns are hidden", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const html = parse(
      (await as(built.app, teamActor).get("/tickets?sort=filed&direction=asc")).text,
    );
    const links = html.querySelectorAll("nav[aria-label='Sort by'] a");
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Key, sort lowest first",
      "Title, sort A to Z",
      "Status, sort New first",
      "Owner, sort A to Z",
      "Filed, sort newest first",
    ]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      headers(html)
        .filter((header) => header.href !== null)
        .map((header) => header.href),
    );
    expect(html.querySelector("nav[aria-label='Sort by'] a[aria-current]")?.text).toBe("Filed ↑");
    // The old order links under the table are gone.
    expect(html.querySelector("nav[aria-label='Order']")).toBeNull();
    // It comes before the table and needs no script.
    const main = html.querySelector("main")!.toString();
    expect(main.indexOf('aria-label="Sort by"')).toBeLessThan(
      main.indexOf('table class="tickets"'),
    );
  });
});

describe("the sort a column, a direction and an order name", () => {
  // The page and the API both read the sort through this one rule, so they cannot drift apart.
  it("takes the column first, its first way without a direction, then the order", () => {
    expect(sortFrom("title", "desc", undefined)).toEqual({ by: "title", direction: "desc" });
    expect(sortFrom("filed", undefined, undefined)).toEqual({ by: "filed", direction: "desc" });
    expect(sortFrom("key", undefined, "oldest")).toEqual({ by: "key", direction: "asc" });
    expect(sortFrom(undefined, "desc", "oldest")).toEqual({ by: "filed", direction: "asc" });
    expect(sortFrom(undefined, "desc", undefined)).toBeUndefined();
  });

  it("lets the page take a column over an order and drop a lone direction", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const keys = async (address: string) =>
      parse((await as(built.app, teamActor).get(address)).text)
        .querySelectorAll("table.tickets tbody tr td:first-child")
        .map((td) => td.text);
    expect(await keys("/tickets?sort=key&order=oldest")).toEqual(
      await keys("/tickets?sort=key&direction=asc"),
    );
    expect(await keys("/tickets?direction=asc")).toEqual(await keys("/tickets"));
  });
});

describe("a sort that cannot be read", () => {
  it("is a 400 from the API and the default list on the page", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const api = await as(built.app, teamActor).get("/api/tickets?sort=sideways");
    expect(api.status).toBe(400);
    expect(api.body.error.fields.sort).toBeDefined();
    const way = await as(built.app, teamActor).get("/api/tickets?sort=title&direction=up");
    expect(way.status).toBe(400);
    expect(way.body.error.fields.direction).toBeDefined();
    const page = await as(built.app, teamActor).get("/tickets?sort=sideways&direction=up");
    expect(page.status).toBe(200);
    const plain = await as(built.app, teamActor).get("/tickets");
    const keys = (text: string) =>
      parse(text)
        .querySelectorAll("table.tickets tbody tr td:first-child")
        .map((td) => td.text);
    expect(keys(page.text)).toEqual(keys(plain.text));
  });

  it("is refused in the API beside an order, or as a direction alone", async () => {
    const built = buildTestApp();
    const both = await as(built.app, teamActor).get("/api/tickets?order=oldest&sort=title");
    expect(both.status).toBe(400);
    expect(both.body.error.fields.sort).toBeDefined();
    const alone = await as(built.app, teamActor).get("/api/tickets?direction=desc");
    expect(alone.status).toBe(400);
    expect(alone.body.error.fields.direction).toBeDefined();
  });

  it("keeps its sort in the API's cursor and refuses a different one beside it", async () => {
    const built = buildTestApp();
    fill(built.db);
    const first = await as(built.app, teamActor).get("/api/tickets?sort=key&direction=desc");
    const cursor = /cursor=([^&>]+)/.exec(String(first.headers.link))![1]!;
    const next = await as(built.app, teamActor).get(`/api/tickets?cursor=${cursor}`);
    expect((next.body as Row[])[0]!.key).toBe(`SUP-${COUNT - LIST_PAGE_SIZE}`);
    const same = await as(built.app, teamActor).get(
      `/api/tickets?cursor=${cursor}&sort=key&direction=desc`,
    );
    expect(same.status).toBe(200);
    const other = await as(built.app, teamActor).get(`/api/tickets?cursor=${cursor}&sort=title`);
    expect(other.status).toBe(400);
    // The refusal names the sort the caller passed, not the older order.
    expect(other.body.error.message).toBe("That cursor was made for another sort.");
    expect(Object.keys(other.body.error.fields)).toEqual(["sort"]);
    const older = await as(built.app, teamActor).get(`/api/tickets?cursor=${cursor}&order=oldest`);
    expect(older.status).toBe(400);
    expect(older.body.error.message).toBe("That cursor was made for another order.");
    expect(Object.keys(older.body.error.fields)).toEqual(["order"]);
  });
});

describe("who sees a sorted list", () => {
  it("gives a customer only the tickets they filed, in their sort", async () => {
    const built = buildTestApp();
    fill(built.db, 8, "dev-customer-1");
    fill(built.db, 8, "dev-customer-2");
    const { rows } = await everyApiPage(built, "/api/tickets?sort=title", customerOne);
    expect(rows).toHaveLength(8);
    expect(rows).toEqual([...rows].sort(promised("title", "asc")));
    const theirs = await everyApiPage(built, "/api/tickets?sort=title", customerTwo);
    const mine = new Set(rows.map((row) => row.key));
    expect(theirs.rows.some((row) => mine.has(row.key))).toBe(false);
    const page = parse((await as(built.app, customerOne).get("/tickets?sort=title")).text);
    const keys = page
      .querySelectorAll("table.tickets tbody tr td:first-child")
      .map((td) => td.text);
    expect(keys).toEqual(rows.map((row) => row.key));
  });
});

describe("the API's description of the sort", () => {
  it("lists every column and both directions, from the action table", async () => {
    const { app } = buildTestApp();
    const doc = (await as(app, teamActor).get("/api/openapi.json")).body;
    const list = doc.paths["/tickets"].get;
    const parameter = (name: string) =>
      list.parameters.find((p: { name: string }) => p.name === name);
    expect(parameter("sort").schema.enum).toEqual([...LIST_SORTS]);
    expect(parameter("direction").schema.enum).toEqual(["asc", "desc"]);
    expect(parameter("sort").description).toContain("Ties are broken by the key");
  });
});

describe("how the team's sorted list reads the table", () => {
  it.each(EVERY_SORT)(
    "%s %s reads in index order, with no sort of the whole table",
    (by, direction) => {
      const built = buildTestApp();
      fill(built.db);
      const spy = vi.spyOn(built.db, "prepare");
      const page = { limit: LIST_PAGE_SIZE, offset: 0 };
      repository.listTickets(built.db, { kind: "everyone" }, null, { by, direction }, page);
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

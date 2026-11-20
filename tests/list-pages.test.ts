import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { as, buildTestApp, teamActor, visitor } from "./helpers.js";

// A long ticket list comes in pages. Under the table, one line says which page this is and
// links to the page before and the page after, keeping the filters, search and sort. The line
// is worked out from how many tickets the view holds, so a list that fills its last page
// exactly never offers an empty page after it, and a page past the end goes to the last page.

type Built = ReturnType<typeof buildTestApp>;

/**
 * Puts tickets straight into the table: `matching` New tickets nobody owns, titled with
 * "export", and `others` owned tickets in progress titled with "import", which the filtered
 * view below leaves out. The filed times do not follow the ids, so the sort is not the key.
 */
function fill(db: Built["db"], matching: number, others = 7): void {
  const insert = db.prepare(
    `INSERT INTO tickets
       (title, description, status, created_by, owner_id, owner_name, created_at, updated_at)
     VALUES (?, 'd', ?, 'dev-customer-1', ?, ?, ?, ?)`,
  );
  const total = matching + others;
  for (let i = 1; i <= total; i++) {
    const filed = new Date(Date.UTC(2026, 0, 1, 0, (i * 53) % total)).toISOString();
    if (i <= matching) {
      insert.run(`Export fails ${i % 9}`, "new", null, null, filed, filed);
    } else {
      insert.run(`Import slow ${i}`, "in_progress", "dev-team-1", "Team One", filed, filed);
    }
  }
}

/** A filter, a search and a sort together. */
const VIEW = "status=open&owner=none&q=export&sort=title&direction=asc";

type ListPage = {
  keys: string[];
  place: string | null;
  previous: string | null;
  next: string | null;
};

/** One page of the list as the team sees it: its keys and its line of pages. */
async function listPage(built: Built, address: string): Promise<ListPage> {
  const res = await as(built.app, teamActor).get(address);
  expect(res.status, address).toBe(200);
  const html = parse(res.text);
  const nav = html.querySelector('nav[aria-label="Pages"]');
  // Looked for anywhere on the page, so a link outside the line would still be followed.
  const link = (words: string) =>
    html
      .querySelectorAll("a")
      .find((a) => a.text === words)
      ?.getAttribute("href") ?? null;
  return {
    keys: html.querySelectorAll("table.tickets tbody tr td:first-child").map((td) => td.text),
    place: nav?.querySelector("span")?.text ?? null,
    previous: link("Previous page"),
    next: link("Next page"),
  };
}

describe("the line of pages under the list", () => {
  it.each([
    [LIST_PAGE_SIZE, 1],
    [LIST_PAGE_SIZE * 2, 2],
    [LIST_PAGE_SIZE * 2 + 1, 3],
  ])(
    "walks %i tickets forward and back, %i pages in all, with no repeat and no skip",
    async (matching, pages) => {
      const built = buildTestApp();
      fill(built.db, matching);
      // Forward, by "Next page".
      const forward: string[][] = [];
      let address: string | null = `/tickets?${VIEW}`;
      while (address !== null) {
        const page = await listPage(built, address);
        forward.push(page.keys);
        const number = forward.length;
        if (pages === 1) {
          // One page has no line at all.
          expect(page.place).toBeNull();
        } else {
          expect(page.place).toBe(`Page ${number} of ${pages}`);
          expect(page.previous === null).toBe(number === 1);
        }
        address = page.next;
        // Every link keeps the filter, the search and the sort.
        if (address !== null) expect(address).toContain(VIEW);
      }
      expect(forward).toHaveLength(pages);
      expect(forward.at(-1)!.length).toBeGreaterThan(0);
      const keys = forward.flat();
      expect(keys).toHaveLength(matching);
      expect(new Set(keys).size).toBe(matching);
      // Back, by "Previous page" from the last page, gives the same pages.
      const back: string[][] = [];
      address = pages === 1 ? null : `/tickets?${VIEW}&page=${pages}`;
      while (address !== null) {
        const page = await listPage(built, address);
        back.unshift(page.keys);
        address = page.previous;
      }
      if (pages > 1) expect(back).toEqual(forward);
    },
  );

  it("is not drawn on a list of one page", async () => {
    const built = buildTestApp();
    fill(built.db, 3);
    const res = await as(built.app, teamActor).get("/tickets");
    expect(parse(res.text).querySelector('nav[aria-label="Pages"]')).toBeNull();
  });
});

describe("a page past the end of the list", () => {
  it("goes to the last page with the same filters", async () => {
    const built = buildTestApp();
    fill(built.db, LIST_PAGE_SIZE + 51);
    const res = await as(built.app, teamActor).get(`/tickets?${VIEW}&page=99`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/tickets?${VIEW}&page=2`);
  });

  it("goes to the plain list when the list has one page", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const res = await as(built.app, teamActor).get("/tickets?owner=none&page=3");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/tickets?owner=none");
  });

  it("reads a page that is not a whole number of 1 or more as page one", async () => {
    const built = buildTestApp();
    fill(built.db, LIST_PAGE_SIZE + 1);
    for (const page of ["abc", "0", "-2", "1.5"]) {
      const shown = await listPage(built, `/tickets?${VIEW}&page=${page}`);
      expect(shown.place, page).toBe("Page 1 of 2");
    }
  });

  it("still says what a change to many tickets did after it emptied the last page", async () => {
    const built = buildTestApp();
    fill(built.db, LIST_PAGE_SIZE + 1);
    const second = await listPage(built, "/tickets?owner=none&page=2");
    expect(second.keys).toHaveLength(1);
    // Taking the one ticket on page two leaves the "Unassigned" view one page long.
    const posted = await as(built.app, teamActor)
      .post("/tickets/bulk?owner=none&page=2")
      .type("form")
      .send({ keys: second.keys, owner: "me" });
    expect(posted.status).toBe(303);
    const cookies = [posted.headers["set-cookie"]]
      .flat()
      .filter((c): c is string => !!c)
      .map((c) => c.split(";")[0]!);
    const browser = (address: string) =>
      visitor(built.app)
        .get(address)
        .set("Cookie", [`${DEV_COOKIE}=${teamActor.id}`, ...cookies]);
    const past = await browser(posted.headers.location as string);
    expect(past.status).toBe(302);
    expect(past.headers.location).toBe("/tickets?owner=none");
    const landed = parse((await browser("/tickets?owner=none")).text);
    expect(landed.querySelector('p[role="status"].saved')?.text).toBeTruthy();
  });
});

describe("the box that ticks every row", () => {
  it("says it ticks this page when the list has more than one", async () => {
    const built = buildTestApp();
    fill(built.db, LIST_PAGE_SIZE + 1);
    const html = parse((await as(built.app, teamActor).get("/tickets")).text);
    const header = html.querySelector("table.tickets thead input[data-bulk-all]");
    expect(header?.getAttribute("aria-label")).toBe("Tick all on this page");
    expect(header?.getAttribute("title")).toBe("Tick all on this page");
    expect(html.querySelector("[data-bulk-phone] label")?.text.trim()).toBe(
      "Tick all on this page",
    );
  });

  it("keeps its words on a list of one page", async () => {
    const built = buildTestApp();
    fill(built.db, 5);
    const html = parse((await as(built.app, teamActor).get("/tickets")).text);
    const header = html.querySelector("table.tickets thead input[data-bulk-all]");
    expect(header?.getAttribute("aria-label")).toBe("Tick every ticket shown");
    expect(html.querySelector("[data-bulk-phone] label")?.text.trim()).toBe("Tick all shown");
  });
});

describe("the API's next page", () => {
  /** How many pages the API gives from this address, following its Link header. */
  async function apiPages(built: Built, first: string) {
    let address: string | null = first;
    const sizes: number[] = [];
    while (address !== null) {
      const res = await as(built.app, teamActor).get(address);
      expect(res.status, res.text).toBe(200);
      sizes.push((res.body as unknown[]).length);
      const next = /<([^>]+)>; rel="next"/.exec(String(res.headers.link ?? ""));
      address = next ? next[1]! : null;
    }
    return sizes;
  }

  it.each([
    [LIST_PAGE_SIZE, [LIST_PAGE_SIZE]],
    [LIST_PAGE_SIZE * 2, [LIST_PAGE_SIZE, LIST_PAGE_SIZE]],
    [LIST_PAGE_SIZE + 1, [LIST_PAGE_SIZE, 1]],
  ])("names no empty page after %i filtered tickets", async (matching, sizes) => {
    const built = buildTestApp();
    fill(built.db, matching);
    expect(await apiPages(built, "/api/tickets?status=new&owner=none&q=export")).toEqual(sizes);
  });

  it("names no empty page after exactly one page of every ticket", async () => {
    const built = buildTestApp();
    fill(built.db, LIST_PAGE_SIZE - 7);
    expect(await apiPages(built, "/api/tickets")).toEqual([LIST_PAGE_SIZE]);
  });
});

import { parse } from "node-html-parser";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// "All" on the ticket list shows every ticket, and "Open" every ticket that is not resolved.
// "Resolved" has a small filter by age: any age (the default), the last 14 days, counted from
// when each ticket last became Resolved, or older. No other status link has it, nor a search.

const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

/** Runs this with the clock set this many days back, and puts the clock back after. */
async function daysAgo<T>(days: number, run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() - days * DAY));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

/** The team resolves this ticket with a reason. */
async function resolve(app: Express, key: string) {
  const res = await as(app, teamActor)
    .post(`/api/tickets/${key}/resolve`)
    .send({ reason: "wont_fix" });
  expect(res.status, res.text).toBe(200);
}

/** The keys the list at this address shows, in order. */
async function keys(app: Express, who: Actor, address: string) {
  const html = parse((await as(app, who).get(address)).text);
  return html
    .querySelectorAll("table.tickets tbody tr")
    .map((row) => row.querySelector("td .ticket-key")!.text);
}

/** The list's filter of resolved tickets by age, or null when there is none. */
async function ageFilter(app: Express, who: Actor, address = "/tickets") {
  const html = parse((await as(app, who).get(address)).text);
  return html.querySelector("nav[aria-label='Resolved tickets by age']");
}

/** Each choice of the filter by age: its words, its address and whether it is lit. */
function choices(nav: NonNullable<Awaited<ReturnType<typeof ageFilter>>>) {
  return nav.querySelectorAll("a").map((link) => ({
    words: link.text.replace(/\s+/g, " ").trim(),
    href: link.getAttribute("href"),
    lit: link.getAttribute("aria-current") === "page",
  }));
}

/** The words of each status filter, with its count. */
async function statusLinks(app: Express, who: Actor, address = "/tickets") {
  const html = parse((await as(app, who).get(address)).text);
  return html
    .querySelectorAll("nav[aria-label='Filter by status'] a")
    .map((link) => link.text.replace(/\s+/g, " ").trim());
}

/** The count beside each status filter. */
async function counts(app: Express, who: Actor, address = "/tickets") {
  const html = parse((await as(app, who).get(address)).text);
  return html
    .querySelectorAll("nav[aria-label='Filter by status'] .filter-count")
    .map((count) => Number(count.text));
}

/**
 * Customer one files SUP-1 "Printer jams" (resolved 15 days ago), SUP-2 "Invoice date wrong"
 * (resolved 13 days ago) and SUP-3 "Login fails" (open). Customer two files SUP-4 "Old export"
 * and SUP-5 "Older export", both resolved 20 days ago.
 */
async function setup() {
  const built = buildTestApp();
  const { app } = built;
  const one = as(app, customerOne);
  const two = as(app, customerTwo);
  await daysAgo(30, async () => {
    await one.post("/api/tickets").send({ title: "Printer jams", description: "x" });
    await one.post("/api/tickets").send({ title: "Invoice date wrong", description: "x" });
    await one.post("/api/tickets").send({ title: "Login fails", description: "x" });
    await two.post("/api/tickets").send({ title: "Old export", description: "x" });
    await two.post("/api/tickets").send({ title: "Older export", description: "x" });
  });
  await daysAgo(20, async () => {
    await resolve(app, "SUP-4");
    await resolve(app, "SUP-5");
  });
  await daysAgo(15, () => resolve(app, "SUP-1"));
  await daysAgo(13, () => resolve(app, "SUP-2"));
  return built;
}

describe("All on the ticket list", () => {
  it("shows every ticket, open ones first, with no filter by age", async () => {
    const { app } = await setup();
    expect(await keys(app, teamActor, "/tickets")).toEqual([
      "SUP-3",
      "SUP-5",
      "SUP-4",
      "SUP-2",
      "SUP-1",
    ]);
    expect(await keys(app, customerOne, "/tickets")).toEqual(["SUP-3", "SUP-2", "SUP-1"]);
    expect(await ageFilter(app, teamActor)).toBeNull();
    // An old address that asked "All" for an age shows every ticket too.
    expect(await keys(app, teamActor, "/tickets?resolved=older")).toHaveLength(5);
    expect(await ageFilter(app, teamActor, "/tickets?resolved=older")).toBeNull();
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    expect(html.querySelector("main")!.text).not.toContain("14 days");
  });
});

describe("Open on the ticket list", () => {
  it("sits between All and New with its count, for the customer and the team", async () => {
    const { app } = await setup();
    expect(await statusLinks(app, teamActor)).toEqual([
      "All",
      "Open 1",
      "New 1",
      "In Progress 0",
      "Resolved 4",
      "Archived",
    ]);
    expect(await statusLinks(app, customerOne)).toEqual([
      "All",
      "Open 1",
      "New 1",
      "In Progress 0",
      "Resolved 2",
    ]);
  });

  it("shows New and In Progress together, and is undone by pressing it again", async () => {
    const { app } = await setup();
    await as(app, teamActor).post("/api/tickets/SUP-3/take-and-start");
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Fax is slow", description: "x" });
    expect(await keys(app, teamActor, "/tickets?status=open")).toEqual(["SUP-6", "SUP-3"]);
    expect(await keys(app, customerOne, "/tickets?status=open")).toEqual(["SUP-6", "SUP-3"]);
    const html = parse((await as(app, teamActor).get("/tickets?status=open")).text);
    expect(html.querySelector("main h1")?.text).toBe("All tickets");
    expect(html.querySelector("title")?.text).toContain("Open tickets");
    const open = html
      .querySelectorAll("nav[aria-label='Filter by status'] a")
      .find((link) => link.text.startsWith("Open"))!;
    expect(open.getAttribute("aria-current")).toBe("page");
    expect(open.getAttribute("href")).toBe("/tickets");
    expect(await ageFilter(app, teamActor, "/tickets?status=open")).toBeNull();
  });

  it("works with the owner filter, the search, the sort and the bulk bar", async () => {
    const { app } = await setup();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Fax is slow", description: "x" });
    await as(app, teamActor).post("/api/tickets/SUP-6/take");
    expect(await keys(app, teamActor, "/tickets?status=open&owner=me")).toEqual(["SUP-6"]);
    expect(await keys(app, teamActor, "/tickets?status=open&owner=none")).toEqual(["SUP-3"]);
    expect(await keys(app, teamActor, "/tickets?status=open&q=login")).toEqual(["SUP-3"]);
    expect(await keys(app, teamActor, "/tickets?status=open&sort=key&direction=asc")).toEqual([
      "SUP-3",
      "SUP-6",
    ]);
    const html = parse((await as(app, teamActor).get("/tickets?status=open")).text);
    expect(html.querySelector("form.list-search input[name=status]")?.getAttribute("value")).toBe(
      "open",
    );
    expect(html.querySelector("form#bulk-form")?.getAttribute("action")).toBe(
      "/tickets/bulk?status=open",
    );
    // Nothing matches: the sentence names the link.
    const none = parse((await as(app, teamActor).get("/tickets?status=open&q=printer")).text);
    expect(none.querySelector("p.empty")?.text).toContain('No open tickets match "printer".');
  });

  it("says there are no open tickets when every ticket is resolved", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await resolve(app, "SUP-1");
    const html = parse((await as(app, customerOne).get("/tickets?status=open")).text);
    expect(html.querySelector("p.empty")?.text).toContain("No open tickets.");
  });
});

describe("Resolved on the ticket list", () => {
  it("offers any age first, lit, then the last 14 days and the older ones with their count", async () => {
    const { app } = await setup();
    const nav = (await ageFilter(app, teamActor, "/tickets?status=resolved"))!;
    // No "Resolved:" label: the group follows the lit Resolved link.
    expect(nav.querySelector(".filter-label")).toBeNull();
    expect(nav.text).not.toContain("Resolved:");
    expect(choices(nav)).toEqual([
      { words: "Any age", href: "/tickets?status=resolved", lit: true },
      { words: "Last 14 days", href: "/tickets?status=resolved&resolved=recent", lit: false },
      { words: "Older 3", href: "/tickets?status=resolved&resolved=older", lit: false },
    ]);
    expect(await keys(app, teamActor, "/tickets?status=resolved")).toEqual([
      "SUP-5",
      "SUP-4",
      "SUP-2",
      "SUP-1",
    ]);
    // The old address for any age answers as the default.
    const any = (await ageFilter(app, teamActor, "/tickets?status=resolved&resolved=any"))!;
    expect(choices(any).map((choice) => choice.lit)).toEqual([true, false, false]);
  });

  it("shows only the recent ones or only the older ones, and keeps the other filters", async () => {
    const { app } = await setup();
    expect(await keys(app, teamActor, "/tickets?status=resolved&resolved=recent")).toEqual([
      "SUP-2",
    ]);
    expect(await keys(app, teamActor, "/tickets?status=resolved&resolved=older")).toEqual([
      "SUP-5",
      "SUP-4",
      "SUP-1",
    ]);
    const older = (await ageFilter(app, teamActor, "/tickets?status=resolved&resolved=older"))!;
    expect(choices(older).map((choice) => choice.lit)).toEqual([false, false, true]);
    // Each choice keeps the owner toggle and the sort, and the owner toggles keep it.
    const kept = (await ageFilter(
      app,
      teamActor,
      "/tickets?status=resolved&owner=me&sort=title&direction=asc",
    ))!;
    expect(choices(kept)[2]).toEqual({
      words: "Older 3",
      href: "/tickets?status=resolved&owner=me&resolved=older&sort=title&direction=asc",
      lit: false,
    });
    const html = parse(
      (await as(app, teamActor).get("/tickets?status=resolved&resolved=older")).text,
    );
    expect(html.querySelector("nav[aria-label='Filter by owner'] a")?.getAttribute("href")).toBe(
      "/tickets?status=resolved&owner=me&resolved=older",
    );
    // Leaving Resolved leaves its age behind.
    const all = html
      .querySelectorAll("nav[aria-label='Filter by status'] a")
      .find((link) => link.text.startsWith("Resolved"))!;
    expect(all.getAttribute("href")).toBe("/tickets");
  });

  it("has no filter by age on the other links or in a search, which show every age", async () => {
    const { app } = await setup();
    for (const address of ["/tickets?status=new", "/tickets?status=in_progress"]) {
      expect(await ageFilter(app, teamActor, address), address).toBeNull();
    }
    expect(await ageFilter(app, teamActor, "/tickets?status=resolved&q=printer")).toBeNull();
    expect(await keys(app, teamActor, "/tickets?status=resolved&q=printer")).toEqual(["SUP-1"]);
    expect(await keys(app, teamActor, "/tickets?status=new&resolved=older")).toEqual(["SUP-3"]);
  });

  it("counts from the last time a reopened ticket was resolved", async () => {
    const { app } = await setup();
    const reopened = await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It came back." });
    expect(reopened.status, reopened.text).toBe(200);
    await resolve(app, "SUP-1");
    expect(await keys(app, teamActor, "/tickets?status=resolved&resolved=recent")).toEqual([
      "SUP-2",
      "SUP-1",
    ]);
  });

  it("counts only a customer's own tickets", async () => {
    const { app } = await setup();
    const older = async (who: Actor) =>
      choices((await ageFilter(app, who, "/tickets?status=resolved"))!)[2]?.words;
    expect(await older(customerOne)).toBe("Older 1");
    expect(await older(customerTwo)).toBe("Older 2");
    expect(await keys(app, customerOne, "/tickets?status=resolved&resolved=older")).toEqual([
      "SUP-1",
    ]);
  });

  it("shows the filter by age whenever there is a resolved ticket, and none without one", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    expect(await ageFilter(app, teamActor, "/tickets?status=resolved")).toBeNull();
    await resolve(app, "SUP-1");
    const nav = (await ageFilter(app, teamActor, "/tickets?status=resolved"))!;
    expect(choices(nav)[2]?.words).toBe("Older 0");
    const html = parse(
      (await as(app, teamActor).get("/tickets?status=resolved&resolved=older")).text,
    );
    expect(html.querySelector("p.empty")?.text).toContain(
      "No tickets were resolved more than 14 days ago.",
    );
  });

  it("says the age when one is chosen and the owner filter leaves none", async () => {
    const { app } = await setup();
    const address = "/tickets?status=resolved&owner=none&resolved=recent";
    const html = parse((await as(app, teamActor).get(address)).text);
    const empty = html.querySelector("p.empty");
    expect(empty?.text.replace(/\s+/g, " ")).toContain(
      "No tickets that nobody owns were resolved in the last 14 days.",
    );
    // Its link clears the owner filter and keeps the age.
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe(
      "/tickets?status=resolved&resolved=recent",
    );
  });

  it("leaves the counts beside the filters unchanged", async () => {
    const { app } = await setup();
    // Open, New, In Progress, Resolved: every resolved ticket, old and new.
    expect(await counts(app, teamActor)).toEqual([1, 1, 0, 4]);
    expect(await counts(app, customerOne)).toEqual([1, 1, 0, 2]);
  });
});

describe("the JSON API's list", () => {
  it("is as it was: every ticket by default, and no open filter", async () => {
    const { app } = await setup();
    const listed = await as(app, teamActor).get("/api/tickets");
    expect(listed.status).toBe(200);
    const tickets = listed.body as { key: string }[];
    expect(tickets.map((ticket) => ticket.key).sort()).toEqual([
      "SUP-1",
      "SUP-2",
      "SUP-3",
      "SUP-4",
      "SUP-5",
    ]);
    expect((await as(app, teamActor).get("/api/tickets?status=open")).status).toBe(400);
  });
});

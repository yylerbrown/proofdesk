import { parse } from "node-html-parser";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// "All" on the ticket list shows the open tickets and the ones resolved in the last 14 days,
// counted from when each last became Resolved. "Resolved" and a search still find every resolved
// ticket. "All" has a filter by age, "Resolved:", that shows the older ones or every one.

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
  it("leaves out tickets resolved more than 14 days ago, and keeps the recent ones", async () => {
    const { app } = await setup();
    expect(await keys(app, teamActor, "/tickets")).toEqual(["SUP-3", "SUP-2"]);
    expect(await keys(app, customerOne, "/tickets")).toEqual(["SUP-3", "SUP-2"]);
    // With every sort and with the owner toggles too.
    expect(await keys(app, teamActor, "/tickets?sort=key&direction=asc")).toEqual([
      "SUP-2",
      "SUP-3",
    ]);
    expect(await keys(app, teamActor, "/tickets?owner=me")).toEqual(["SUP-2"]);
  });

  it("keeps every resolved ticket under Resolved, and in a search for its title", async () => {
    const { app } = await setup();
    expect(await keys(app, teamActor, "/tickets?status=resolved")).toEqual([
      "SUP-5",
      "SUP-4",
      "SUP-2",
      "SUP-1",
    ]);
    expect(await keys(app, teamActor, "/tickets?q=printer")).toEqual(["SUP-1"]);
    expect(await keys(app, customerOne, "/tickets?q=printer")).toEqual(["SUP-1"]);
    // A search finds every age, so there is no filter by age while one is typed.
    expect(await ageFilter(app, teamActor, "/tickets?q=printer")).toBeNull();
  });

  it("counts a ticket reopened and resolved again from the last time", async () => {
    const { app } = await setup();
    const reopened = await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It came back." });
    expect(reopened.status, reopened.text).toBe(200);
    await resolve(app, "SUP-1");
    expect(await keys(app, teamActor, "/tickets")).toEqual(["SUP-3", "SUP-2", "SUP-1"]);
  });

  it("offers the last 14 days, the older ones with their count, and any age", async () => {
    const { app } = await setup();
    const nav = (await ageFilter(app, teamActor))!;
    expect(nav.querySelector(".filter-label")?.text).toBe("Resolved:");
    expect(choices(nav)).toEqual([
      { words: "Last 14 days", href: "/tickets", lit: true },
      { words: "Older 3", href: "/tickets?resolved=older", lit: false },
      { words: "Any age", href: "/tickets?resolved=any", lit: false },
    ]);
    // The line under the list it replaces is gone.
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    expect(html.querySelector(".older-resolved")).toBeNull();
    expect(html.querySelector("main")!.text).not.toContain("older resolved");
  });

  it("shows only the older ones, or every ticket, and keeps the other filters", async () => {
    const { app } = await setup();
    expect(await keys(app, teamActor, "/tickets?resolved=older")).toEqual([
      "SUP-5",
      "SUP-4",
      "SUP-1",
    ]);
    expect(await keys(app, teamActor, "/tickets?resolved=any")).toEqual([
      "SUP-3",
      "SUP-5",
      "SUP-4",
      "SUP-2",
      "SUP-1",
    ]);
    const older = (await ageFilter(app, teamActor, "/tickets?resolved=older"))!;
    expect(choices(older).map((choice) => choice.lit)).toEqual([false, true, false]);
    // Each choice keeps the owner toggle and the sort, and the owner toggles keep it.
    const kept = (await ageFilter(app, teamActor, "/tickets?owner=me&sort=title&direction=asc"))!;
    expect(choices(kept)[1]).toEqual({
      words: "Older 3",
      href: "/tickets?owner=me&resolved=older&sort=title&direction=asc",
      lit: false,
    });
    const html = parse((await as(app, teamActor).get("/tickets?resolved=older")).text);
    expect(html.querySelector("nav[aria-label='Filter by owner'] a")?.getAttribute("href")).toBe(
      "/tickets?owner=me&resolved=older",
    );
    // Not on the other filters, nor in a search, which already show every age.
    expect(await ageFilter(app, teamActor, "/tickets?status=resolved")).toBeNull();
    expect(await ageFilter(app, teamActor, "/tickets?status=new")).toBeNull();
    expect(await keys(app, teamActor, "/tickets?status=new&resolved=older")).toEqual(["SUP-3"]);
  });

  it("counts only a customer's own tickets, and says when none is older", async () => {
    const { app } = await setup();
    expect(choices((await ageFilter(app, customerOne))!)[1]?.words).toBe("Older 1");
    expect(choices((await ageFilter(app, customerTwo))!)[1]?.words).toBe("Older 2");
    expect(await keys(app, customerOne, "/tickets?resolved=older")).toEqual(["SUP-1"]);
    // Customer two has nothing open or recent, and is not told they never filed a ticket.
    const html = parse((await as(app, customerTwo).get("/tickets")).text);
    expect(html.querySelector("p.empty")?.text).toContain("No open tickets.");
  });

  it("shows no filter by age when no resolved ticket is older", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await resolve(app, "SUP-1");
    expect(await keys(app, teamActor, "/tickets")).toEqual(["SUP-1"]);
    expect(await ageFilter(app, teamActor)).toBeNull();
    // Asked for in the address, it shows, so its lit choice can be undone.
    const asked = (await ageFilter(app, teamActor, "/tickets?resolved=older"))!;
    expect(choices(asked)[1]).toEqual({
      words: "Older 0",
      href: "/tickets?resolved=older",
      lit: true,
    });
    const html = parse((await as(app, teamActor).get("/tickets?resolved=older")).text);
    expect(html.querySelector("p.empty")?.text).toContain(
      "No tickets were resolved more than 14 days ago.",
    );
  });

  it("says the age when only older tickets are shown and the owner filter leaves none", async () => {
    const { app } = await setup();
    // SUP-3 is open and nobody owns it, so the sentence must not say there is no such ticket.
    expect(await keys(app, teamActor, "/tickets?owner=none")).toEqual(["SUP-3"]);
    const html = parse((await as(app, teamActor).get("/tickets?owner=none&resolved=older")).text);
    const empty = html.querySelector("p.empty");
    expect(empty?.text.replace(/\s+/g, " ")).toContain(
      "No tickets that nobody owns were resolved more than 14 days ago.",
    );
    // Its link clears the owner filter and keeps the age.
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe("/tickets?resolved=older");
  });

  it("leaves the counts beside the filters unchanged", async () => {
    const { app } = await setup();
    // New, In Progress, Resolved: every resolved ticket, old and new.
    expect(await counts(app, teamActor)).toEqual([1, 0, 4]);
    expect(await counts(app, customerOne)).toEqual([1, 0, 2]);
  });

  it("leaves the JSON API's list as it was: every ticket by default", async () => {
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
  });
});

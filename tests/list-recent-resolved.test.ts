import { parse } from "node-html-parser";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// "All" on the ticket list shows the open tickets and the ones resolved in the last 14 days,
// counted from when each last became Resolved. "Resolved" and a search still find every resolved
// ticket, and one quiet line under "All" says how many older ones it leaves out.

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

/** The line under the list about older resolved tickets, or null when there is none. */
async function footLine(app: Express, who: Actor, address = "/tickets") {
  const html = parse((await as(app, who).get(address)).text);
  return html.querySelector(".older-resolved");
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
    // Nothing is left out while a search is typed, so there is no line.
    expect(await footLine(app, teamActor, "/tickets?q=printer")).toBeNull();
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

  it("says under the list how many older resolved tickets are under Resolved", async () => {
    const { app } = await setup();
    const line = await footLine(app, teamActor);
    expect(line?.text.trim()).toBe("3 older resolved tickets are under Resolved.");
    expect(line?.querySelector("a")?.getAttribute("href")).toBe("/tickets?status=resolved");
    // The link keeps the owner toggle and the sort.
    const kept = await footLine(app, teamActor, "/tickets?owner=me&sort=title&direction=asc");
    expect(kept?.text.trim()).toBe("3 older resolved tickets are under Resolved.");
    expect(kept?.querySelector("a")?.getAttribute("href")).toBe(
      "/tickets?status=resolved&owner=me&sort=title&direction=asc",
    );
    // Not on the other filters, which leave nothing out.
    expect(await footLine(app, teamActor, "/tickets?status=resolved")).toBeNull();
    expect(await footLine(app, teamActor, "/tickets?status=new")).toBeNull();
  });

  it("counts only a customer's own tickets in the line", async () => {
    const { app } = await setup();
    expect((await footLine(app, customerOne))?.text.trim()).toBe(
      "1 older resolved ticket is under Resolved.",
    );
    expect((await footLine(app, customerTwo))?.text.trim()).toBe(
      "2 older resolved tickets are under Resolved.",
    );
    // Customer two has nothing open or recent, and is not told they never filed a ticket.
    const html = parse((await as(app, customerTwo).get("/tickets")).text);
    expect(html.querySelector("p.empty")?.text).toContain("No open tickets.");
  });

  it("shows no line when nothing is left out", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    await resolve(app, "SUP-1");
    expect(await keys(app, teamActor, "/tickets")).toEqual(["SUP-1"]);
    expect(await footLine(app, teamActor)).toBeNull();
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

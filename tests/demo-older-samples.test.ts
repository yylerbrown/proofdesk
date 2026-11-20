import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { RECORDED_SAMPLE_KEY, seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The demo seeds two samples resolved weeks ago, so the filter by age under "Resolved" has
// older tickets to show, and files the recorded assistant run fourth, so it has the key its own words
// name. No other sample's key changes.

const DAY = 24 * 60 * 60 * 1000;

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(built.db, built.config.ticketPrefix);
  seedDemo(service);
  const asDemo = (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  return { ...built, service, asDemo };
}

/** How many whole days ago this time was. */
const daysAgo = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / DAY);

describe("the demo's older samples", () => {
  it("are filed last, resolved 20 and 35 days ago", async () => {
    const { asDemo } = demo();
    const twoFactor = (await asDemo("demo-team").get("/api/tickets/SUP-9")).body;
    expect(twoFactor).toMatchObject({
      title: "Two-factor code arrives after it expires",
      status: "resolved",
      created_by: "demo-customer",
    });
    // Marked fixed by the team, then confirmed by its customer.
    expect(twoFactor.resolution.by).toBe("customer");
    // Filed two days before it was resolved, then confirmed the same day it was resolved.
    expect(daysAgo(twoFactor.updated_at)).toBe(20);
    expect(daysAgo(twoFactor.created_at)).toBe(22);
    const accents = (await asDemo("demo-team").get("/api/tickets/SUP-10")).body;
    expect(accents).toMatchObject({ title: "Export to CSV drops accents", status: "resolved" });
    expect(accents.resolution).toMatchObject({ by: "team", reason: "wont_fix" });
    expect(daysAgo(accents.resolution.at)).toBe(35);
    expect(daysAgo(accents.updated_at)).toBe(35);
  });

  it("keep every History entry at its own past time, so no line says it happened today", async () => {
    const { asDemo } = demo();
    for (const [key, filed, resolved] of [
      ["SUP-9", 22, 20],
      ["SUP-10", 37, 35],
    ] as const) {
      const events = (await asDemo("demo-team").get(`/api/tickets/${key}/events`)).body as {
        type: string;
        created_at: string;
      }[];
      const days = events.map((event) => [event.type, daysAgo(event.created_at)]);
      expect(days[0]).toEqual(["created", filed]);
      expect(days).toContainEqual(["resolved_by_team", resolved]);
      for (const [, ago] of days) expect(ago).toBeGreaterThanOrEqual(resolved);
    }
  });

  it("say on the customer's own page the day the customer confirmed, weeks ago", async () => {
    const { asDemo } = demo();
    const page = parse((await asDemo("demo-customer").get("/tickets/SUP-9")).text);
    // The page writes a day as "31 Oct 2026", in UTC.
    const dayOf = (time: number) =>
      new Date(time).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
    const text = page.text.replace(/\s+/g, " ");
    // The sample is confirmed two hours after it is resolved, so late in the UTC day that is the
    // next day. Either day is right; today's date never is.
    const resolved = Date.now() - 20 * DAY;
    const confirmedDays = [dayOf(resolved), dayOf(resolved + 2 * 60 * 60 * 1000)];
    expect(confirmedDays.some((day) => text.includes(`customer confirmed on ${day}`))).toBe(true);
    const today = dayOf(Date.now());
    expect(text).not.toContain(today);
  });

  it("are under Resolved's Older on the list, and last on All", async () => {
    const { asDemo } = demo();
    const keys = async (id: string, address: string) =>
      parse((await asDemo(id).get(address)).text)
        .querySelectorAll("table.tickets tbody .ticket-key")
        .map((key) => key.text);
    // "All" shows every ticket, so the older resolved ones sit among the resolved ones at its end.
    const all = await keys("demo-team", "/tickets");
    expect(all).toContain("SUP-9");
    expect(all).toContain("SUP-10");
    expect(await keys("demo-team", "/tickets?status=resolved&resolved=older")).toEqual([
      "SUP-10",
      "SUP-9",
    ]);
    // The demo customer sees only their own.
    expect(await keys("demo-customer", "/tickets?status=resolved&resolved=older")).toEqual([
      "SUP-9",
    ]);
    const nav = parse(
      (await asDemo("demo-customer").get("/tickets?status=resolved")).text,
    ).querySelector("nav[aria-label='Resolved tickets by age']");
    expect(nav?.querySelectorAll("a").map((link) => link.text.replace(/\s+/g, " ").trim())).toEqual(
      ["Any age", "Last 14 days", "Older 1"],
    );
  });

  it("leave the recorded run on the key its words name, and the invoice on SUP-2", async () => {
    const { service, asDemo } = demo();
    expect(service.recordedRunKey()).toBe(RECORDED_SAMPLE_KEY);
    expect((await asDemo("demo-team").get("/api/tickets/SUP-2")).body.title).toBe(
      "Invoice shows the wrong date",
    );
    // SUP-3, which the tour names, keeps its key.
    expect((await asDemo("demo-team").get("/api/tickets/SUP-3")).body.title).toBe(
      "Cannot sign in on my phone",
    );
  });
});

import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { RECORDED_SAMPLE_KEY, seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The demo seeds two samples resolved weeks ago, so the list's "Resolved:" filter has older
// tickets to show, and files the recorded assistant run fourth, so it has the key its own words
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
    // The ticket's own times move back. Its History keeps the times seeding wrote, since a
    // history entry never changes.
    expect(daysAgo(twoFactor.updated_at)).toBe(20);
    expect(daysAgo(twoFactor.created_at)).toBe(20);
    const accents = (await asDemo("demo-team").get("/api/tickets/SUP-10")).body;
    expect(accents).toMatchObject({ title: "Export to CSV drops accents", status: "resolved" });
    expect(accents.resolution).toMatchObject({ by: "team", reason: "wont_fix" });
    expect(daysAgo(accents.resolution.at)).toBe(35);
    expect(daysAgo(accents.updated_at)).toBe(35);
  });

  it("are under Older on the list, not on its first look", async () => {
    const { asDemo } = demo();
    const keys = async (id: string, address: string) =>
      parse((await asDemo(id).get(address)).text)
        .querySelectorAll("table.tickets tbody .ticket-key")
        .map((key) => key.text);
    expect(await keys("demo-team", "/tickets")).not.toContain("SUP-9");
    expect(await keys("demo-team", "/tickets")).not.toContain("SUP-10");
    expect(await keys("demo-team", "/tickets?resolved=older")).toEqual(["SUP-10", "SUP-9"]);
    // The demo customer sees only their own.
    expect(await keys("demo-customer", "/tickets?resolved=older")).toEqual(["SUP-9"]);
    const nav = parse((await asDemo("demo-customer").get("/tickets")).text).querySelector(
      "nav[aria-label='Resolved tickets by age']",
    );
    expect(nav?.querySelectorAll("a").map((link) => link.text.replace(/\s+/g, " ").trim())).toEqual(
      ["Last 14 days", "Older 1", "Any age"],
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

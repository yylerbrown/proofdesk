import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { formatDay } from "../src/server/pages/format.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The day on the ticket page's card is a <time> holding the stored instant, marked data-day,
// so the visitor's browser writes it as their own day, like every other time on the page. The
// UTC day stays as its text for a page without scripts.

async function pageOf(id: string, key: string) {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const res = await visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).get(`/tickets/${key}`);
  expect(res.status).toBe(200);
  return parse(res.text);
}

describe("the day on the card's line", () => {
  it("is a time element with the stored instant, after the customer's Yes", async () => {
    const line = (await pageOf("demo-team", "SUP-6")).querySelector(".ticket-card .card-line")!;
    const day = line.querySelector("time[data-day]")!;
    const iso = day.getAttribute("datetime")!;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(day.text).toBe(formatDay(iso));
    expect(line.text.trim()).toBe(`Customer confirmed on ${formatDay(iso)}.`);
  });

  it("is a time element in the line about the customer's No, with a quiet link to their message", async () => {
    const page = await pageOf("demo-team", "SUP-7");
    const line = page.querySelector(".ticket-card .card-line")!;
    const day = line.querySelector("time[data-day]")!;
    expect(line.querySelector("span")!.text.trim()).toBe(
      `The customer said it is not fixed on ${formatDay(day.getAttribute("datetime")!)}.`,
    );
    // The words are not a link; one quiet link after them opens the message, written at the
    // same instant the card names.
    expect(day.closest("a")).toBeNull();
    const link = line.querySelector("a.card-line-link")!;
    expect(link.text).toBe("Read their message");
    const message = page.querySelector(`${link.getAttribute("href")} time[datetime]`);
    expect(message?.getAttribute("datetime")).toBe(day.getAttribute("datetime"));
  });
});

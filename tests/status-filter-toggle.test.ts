import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { adminActor, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The status filters are toggles, like the owner filters: pressing the lit one goes back to
// the same view without a status. All stays, and is lit when no status is chosen.

async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "x" });
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take");
  return built;
}

/** Each status filter on the page as its label, its link and whether it is lit. */
async function statusFilters(app: Express, address: string) {
  const html = parse((await as(app, adminActor).get(address)).text);
  return html.querySelectorAll("nav[aria-label='Filter by status'] a").map((a) => ({
    label: a.text.trim().replace(/ \d+$/, ""),
    href: a.getAttribute("href"),
    lit: a.getAttribute("aria-current") === "page",
  }));
}

describe("the status filters", () => {
  it("clear the lit one on a second press, keeping the owner, the search and the sort", async () => {
    const { app } = await setup();
    const kept = "owner=me&q=print&sort=title&direction=asc";
    for (const status of ["open", "new", "in_progress", "resolved", "archived"]) {
      const filters = await statusFilters(app, `/tickets?status=${status}&${kept}`);
      const lit = filters.filter((filter) => filter.lit);
      expect(lit, status).toHaveLength(1);
      expect(lit[0]?.href, status).toBe(`/tickets?${kept}`);
      // Every other filter still goes to its own status.
      for (const filter of filters.filter((other) => !other.lit && other.label !== "All")) {
        expect(filter.href, filter.label).toMatch(/^\/tickets\?status=\w+&owner=me&q=print/);
      }
    }
  });

  it("light All when no status is chosen, and every status leads to its own view", async () => {
    const { app } = await setup();
    expect(await statusFilters(app, "/tickets")).toEqual([
      { label: "All", href: "/tickets", lit: true },
      { label: "Open", href: "/tickets?status=open", lit: false },
      { label: "New", href: "/tickets?status=new", lit: false },
      { label: "In Progress", href: "/tickets?status=in_progress", lit: false },
      { label: "Resolved", href: "/tickets?status=resolved", lit: false },
      { label: "Archived", href: "/tickets?status=archived", lit: false },
    ]);
  });
});

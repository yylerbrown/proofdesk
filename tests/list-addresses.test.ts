import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";
import type { Actor } from "../src/server/actor.js";

// A person reaches the ticket list from a bookmark, a shared link, a role switch or by editing
// the address. Whatever the address says, the page shows a list, never an error page. The JSON
// API stays strict: a program gets a 400 or 403 it can act on.

async function setup() {
  const built = buildTestApp();
  const one = as(built.app, customerOne);
  await one.post("/api/tickets").send({ title: "Printer jams on page two", description: "x" });
  await one.post("/api/tickets").send({ title: "Invoice date wrong", description: "y" });
  await one.post("/api/tickets").send({ title: "Old request", description: "z" });
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await admin(built.app).post("/api/tickets/SUP-3/archive");
  return built;
}

/** The list page at this address: its status, the ticket keys shown and the current filters. */
async function listPage(app: Express, who: Actor, query: string) {
  const res = await as(app, who).get(`/tickets${query}`);
  const html = parse(res.text);
  return {
    status: res.status,
    text: res.text,
    keys: html.querySelectorAll("table.tickets tbody tr td:first-child a").map((a) => a.text),
    current: html.querySelectorAll('[aria-current="page"]').map((a) => a.text.trim()),
  };
}

describe("a filter the viewer cannot use", () => {
  it("shows a customer their own list for the Archived address, as after a role switch", async () => {
    const { app } = await setup();
    const page = await listPage(app, customerOne, "?status=archived");
    expect(page.status).toBe(200);
    expect(page.keys).toEqual(["SUP-2", "SUP-1"]);
    expect(page.current).toContain("All");
    expect(page.text).not.toContain("status=archived");
    expect(page.text).not.toContain("Old request");
  });

  it("drops the owner filter for a customer, whose list has none", async () => {
    const { app } = await setup();
    const page = await listPage(app, customerOne, "?owner=me");
    expect(page.status).toBe(200);
    expect(page.keys).toEqual(["SUP-2", "SUP-1"]);
  });

  it("still lists archived tickets for the team", async () => {
    const { app } = await setup();
    const page = await listPage(app, teamActor, "?status=archived");
    expect(page.keys).toEqual(["SUP-3"]);
  });
});

describe("a hand-edited address", () => {
  it("reads a status in any case, with spaces or a dash", async () => {
    const { app } = await setup();
    for (const status of ["NEW", "%20New%20", "New"]) {
      expect((await listPage(app, teamActor, `?status=${status}`)).keys).toEqual(["SUP-2"]);
    }
    for (const status of ["in-progress", "In%20Progress", "IN_PROGRESS"]) {
      expect((await listPage(app, teamActor, `?status=${status}`)).keys).toEqual(["SUP-1"]);
    }
  });

  it("shows every ticket for an unknown, empty or repeated status", async () => {
    const { app } = await setup();
    for (const query of ["?status=done", "?status=", "?status=new&status=resolved"]) {
      const page = await listPage(app, teamActor, query);
      expect(page.status).toBe(200);
      expect(page.keys).toEqual(["SUP-2", "SUP-1"]);
      expect(page.current).toContain("All");
      expect(page.text).not.toContain("Invalid option");
    }
  });

  it("shows the first page for a page that is not a number", async () => {
    const { app } = await setup();
    for (const query of ["?page=abc", "?page=0", "?page=1.5", "?page=-2"]) {
      const page = await listPage(app, teamActor, query);
      expect(page.status).toBe(200);
      expect(page.keys).toEqual(["SUP-2", "SUP-1"]);
      expect(page.text).not.toContain("expected number");
    }
  });

  it("shows the list without the owner filter or search it cannot read", async () => {
    const { app } = await setup();
    expect((await listPage(app, teamActor, "?owner=Mine")).keys).toEqual(["SUP-2", "SUP-1"]);
    expect((await listPage(app, teamActor, "?owner=ME")).keys).toEqual(["SUP-1"]);
    const long = await listPage(app, teamActor, `?q=${"a".repeat(101)}`);
    expect(long.status).toBe(200);
    expect(long.keys).toEqual(["SUP-2", "SUP-1"]);
    expect((await listPage(app, teamActor, "?q=a&q=b")).keys).toEqual(["SUP-2", "SUP-1"]);
  });

  it("keeps the JSON API strict about the same addresses", async () => {
    const { app } = await setup();
    const team = as(app, teamActor);
    expect((await team.get("/api/tickets?status=done")).status).toBe(400);
    expect((await team.get("/api/tickets?page=abc")).status).toBe(400);
    expect((await team.get("/api/tickets?owner=Mine")).status).toBe(400);
    expect((await as(app, customerOne).get("/api/tickets?status=archived")).status).toBe(403);
  });
});

describe("each ticket row", () => {
  it("is one stop for the keyboard: the key link, with the title link out of the Tab order", async () => {
    const { app } = await setup();
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    const row = html.querySelector("table.tickets tbody tr")!;
    const links = row.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links.filter((a) => a.getAttribute("tabindex") !== "-1")).toHaveLength(1);
    expect(row.querySelector("td.title-cell a")!.getAttribute("tabindex")).toBe("-1");
  });
});

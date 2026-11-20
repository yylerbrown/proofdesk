import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// Two things on the ticket list: the count beside each status filter, decided the same way as
// the list itself, and a ticket key typed into the search, which opens that ticket when the
// viewer may see it and is otherwise an ordinary search.

/** Customer one files three tickets and customer two files two; the team works on some. */
async function setup() {
  const built = buildTestApp();
  const one = as(built.app, customerOne);
  await one.post("/api/tickets").send({ title: "Printer jams", description: "x" }); // SUP-1
  await one.post("/api/tickets").send({ title: "Invoice date wrong", description: "x" }); // SUP-2
  await one.post("/api/tickets").send({ title: "Printer smokes", description: "x" }); // SUP-3
  const two = as(built.app, customerTwo);
  await two.post("/api/tickets").send({ title: "Printer is slow", description: "x" }); // SUP-4
  await two.post("/api/tickets").send({ title: "Login fails", description: "x" }); // SUP-5
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await as(built.app, teamActor).post("/api/tickets/SUP-4/take-and-start");
  return built;
}

/** The count beside each status filter on the list at this address. */
async function counts(app: Express, who: Actor, address = "/tickets") {
  const html = parse((await as(app, who).get(address)).text);
  return Object.fromEntries(
    html
      .querySelectorAll("nav[aria-label='Filter by status'] a")
      .filter((a) => a.querySelector(".filter-count"))
      .map((a) => [
        a.text.replace(/\s+\d+\s*$/, "").trim(),
        Number(a.querySelector(".filter-count")!.text),
      ]),
  );
}

/** How many tickets the list at this address shows. */
async function shown(app: Express, who: Actor, address: string) {
  return parse((await as(app, who).get(address)).text).querySelectorAll("table.tickets tbody tr")
    .length;
}

describe("the counts beside the status filters", () => {
  it("cover only a customer's own tickets, and equal their own filtered lists", async () => {
    const { app } = await setup();
    for (const [who, expected] of [
      [customerOne, { New: 2, "In Progress": 1, Resolved: 0 }],
      [customerTwo, { New: 1, "In Progress": 1, Resolved: 0 }],
    ] as const) {
      expect(await counts(app, who)).toEqual(expected);
      expect(await shown(app, who, "/tickets?status=new")).toBe(expected.New);
      expect(await shown(app, who, "/tickets?status=in_progress")).toBe(expected["In Progress"]);
    }
  });

  it("count everyone's tickets for the team", async () => {
    const { app } = await setup();
    expect(await counts(app, teamActor)).toEqual({ New: 3, "In Progress": 2, Resolved: 0 });
  });

  it("honour the owner filter and the search in force, as the list does", async () => {
    const { app } = await setup();
    expect(await counts(app, teamActor, "/tickets?q=printer")).toEqual({
      New: 1,
      "In Progress": 2,
      Resolved: 0,
    });
    expect(await counts(app, teamActor, "/tickets?owner=me")).toEqual({
      New: 0,
      "In Progress": 2,
      Resolved: 0,
    });
    expect(await counts(app, teamActor, "/tickets?owner=none&q=printer")).toEqual({
      New: 1,
      "In Progress": 0,
      Resolved: 0,
    });
    // A customer's search counts only their own matches.
    expect(await counts(app, customerTwo, "/tickets?q=printer")).toEqual({
      New: 0,
      "In Progress": 1,
      Resolved: 0,
    });
  });
});

describe("a ticket key typed into the search", () => {
  it("opens the ticket, in any case, when the viewer may see it", async () => {
    const { app } = await setup();
    for (const typed of ["SUP-3", "sup-3", " Sup-3 "]) {
      const res = await as(app, customerOne).get(`/tickets?q=${encodeURIComponent(typed)}`);
      expect(res.status, typed).toBe(302);
      expect(res.headers.location).toBe("/tickets/SUP-3");
    }
    const team = await as(app, teamActor).get("/tickets?q=sup-4");
    expect(team.headers.location).toBe("/tickets/SUP-4");
  });

  it("is an ordinary search for a customer who types another customer's key", async () => {
    const { app } = await setup();
    const other = await as(app, customerOne).get("/tickets?q=SUP-4");
    const missing = await as(app, customerOne).get("/tickets?q=SUP-99");
    expect(other.status).toBe(200);
    expect(missing.status).toBe(200);
    const empty = (res: typeof other) => parse(res.text).querySelector("p.empty")?.text;
    // The same answer as for a key that does not exist, so it tells them nothing.
    expect(empty(other)).toBe('No tickets match "SUP-4". Clear the search.');
    expect(empty(missing)).toBe('No tickets match "SUP-99". Clear the search.');
  });

  it("leaves other words, and a key inside other words, to the ordinary search", async () => {
    const { app } = await setup();
    expect((await as(app, teamActor).get("/tickets?q=printer")).status).toBe(200);
    expect((await as(app, teamActor).get("/tickets?q=see%20SUP-3")).status).toBe(200);
    expect((await as(app, teamActor).get("/tickets?q=SUP-03")).status).toBe(200);
  });

  it("says in the search box's hint that Enter searches, with the full sentence as its name", async () => {
    const { app } = await setup();
    const box = parse((await as(app, teamActor).get("/tickets")).text).querySelector(
      "form.list-search input[name=q]",
    )!;
    expect(box.getAttribute("placeholder")).toBe("Search, then press Enter");
    expect(box.getAttribute("aria-label")).toBe(
      "Search titles and descriptions, or open a ticket by its key",
    );
  });
});

describe("the sentence when nothing matches", () => {
  it("names the status tab and only what is set", async () => {
    const { app } = await setup();
    const empty = async (address: string) =>
      parse((await as(app, teamActor).get(address)).text).querySelector("p.empty")?.text;
    expect(await empty("/tickets?status=resolved&q=zzz")).toBe(
      'No resolved tickets match "zzz". Clear the search.',
    );
    expect(await empty("/tickets?status=new&owner=me")).toBe(
      "No new tickets that you own. Clear the owner filter.",
    );
    expect(await empty("/tickets?status=in_progress&owner=none&q=zzz")).toBe(
      'No tickets in progress that nobody owns and match "zzz". Clear the owner filter and the search.',
    );
  });
});

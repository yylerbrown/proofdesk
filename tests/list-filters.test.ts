import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// The ticket list's filters for the team: whose tickets (everyone, mine, nobody's yet) and words
// to find in the title or description, beside the status. They combine in the address, so a
// filtered view can be shared, and the JSON API takes the same ones.

async function setup() {
  const built = buildTestApp();
  const one = as(built.app, customerOne);
  await one.post("/api/tickets").send({ title: "Printer jams on page two", description: "x" });
  await one
    .post("/api/tickets")
    .send({ title: "Invoice date wrong", description: "The invoice shows 50% off" });
  await one.post("/api/tickets").send({ title: "Login fails", description: "On my phone" });
  await one.post("/api/tickets").send({ title: "Password reset_link broken", description: "y" });
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take");
  await as(built.app, teamActor).post("/api/tickets/SUP-2/take-and-start");
  await admin(built.app).post("/api/tickets/SUP-3/take");
  return built;
}

const keys = async (app: Express, query: string, who = teamActor) =>
  ((await as(app, who).get(`/api/tickets${query}`)).body as { key: string }[]).map((t) => t.key);

describe("narrowing by owner", () => {
  it("shows my tickets or the unassigned ones, together with the status", async () => {
    const { app } = await setup();
    expect(await keys(app, "?owner=me")).toEqual(["SUP-2", "SUP-1"]);
    expect(await keys(app, "?owner=none")).toEqual(["SUP-4"]);
    expect(await keys(app, "?owner=me&status=new")).toEqual(["SUP-1"]);
    expect((await as(app, teamActor).get("/api/tickets?owner=someone")).status).toBe(400);
  });
});

describe("searching", () => {
  it("finds words in the title or the description, in any case, and takes % and _ as plain", async () => {
    const { app } = await setup();
    expect(await keys(app, "?q=printer")).toEqual(["SUP-1"]);
    expect(await keys(app, "?q=INVOICE")).toEqual(["SUP-2"]);
    expect(await keys(app, `?q=${encodeURIComponent("50%")}`)).toEqual(["SUP-2"]);
    expect(await keys(app, "?q=_")).toEqual(["SUP-4"]);
    expect(await keys(app, "?q=phone&owner=me")).toEqual([]);
  });

  it("reads an empty box as no search, and refuses words over 100 characters", async () => {
    const { app } = await setup();
    expect(await keys(app, "?q=")).toHaveLength(4);
    expect((await as(app, teamActor).get("/tickets?q=")).status).toBe(200);
    expect((await as(app, teamActor).get(`/api/tickets?q=${"a".repeat(101)}`)).status).toBe(400);
  });

  it("finds only a customer's own tickets", async () => {
    const { app } = await setup();
    await as(app, customerTwo)
      .post("/api/tickets")
      .send({ title: "Printer smokes", description: "z" });
    expect(await keys(app, "?q=printer", customerOne)).toEqual(["SUP-1"]);
    expect(await keys(app, "?q=printer", customerTwo)).toEqual(["SUP-5"]);
  });
});

describe("the filters on the page", () => {
  it("keep each other in every link and in the search form, so the address can be shared", async () => {
    const { app } = await setup();
    const html = parse((await as(app, teamActor).get("/tickets?status=new&owner=me&q=print")).text);
    // A status link also holds its count, as in "In Progress 1".
    const link = (label: string, nav: string) =>
      html
        .querySelectorAll(`nav[aria-label='${nav}'] a`)
        .find((a) => a.text.trim().replace(/ \d+$/, "") === label)!;
    expect(link("In Progress", "Filter by status").getAttribute("href")).toBe(
      "/tickets?status=in_progress&owner=me&q=print",
    );
    expect(link("Unassigned", "Filter by owner").getAttribute("href")).toBe(
      "/tickets?status=new&owner=none&q=print",
    );
    // Mine is lit, so pressing it again clears the owner filter and keeps the rest.
    expect(link("Mine", "Filter by owner").getAttribute("href")).toBe(
      "/tickets?status=new&q=print",
    );
    expect(link("New", "Filter by status").getAttribute("aria-current")).toBe("page");
    expect(link("Mine", "Filter by owner").getAttribute("aria-current")).toBe("page");
    expect(link("Unassigned", "Filter by owner").getAttribute("aria-current")).toBeUndefined();
    const form = html.querySelector("form.list-search")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.querySelector("input[name=status]")?.getAttribute("value")).toBe("new");
    expect(form.querySelector("input[name=owner]")?.getAttribute("value")).toBe("me");
    expect(form.querySelector("input[name=q]")?.getAttribute("value")).toBe("print");
    expect(
      html.querySelectorAll("table.tickets tbody tr td:first-child").map((td) => td.text),
    ).toEqual(["SUP-1"]);
  });

  it("are two owner toggles for the team, neither lit until pressed, with no Everyone", async () => {
    const { app } = await setup();
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    const owners = html.querySelectorAll("nav[aria-label='Filter by owner'] a");
    expect(owners.map((a) => [a.text, a.getAttribute("href")])).toEqual([
      ["Mine", "/tickets?owner=me"],
      ["Unassigned", "/tickets?owner=none"],
    ]);
    expect(owners.filter((a) => a.hasAttribute("aria-current"))).toEqual([]);
    expect(html.querySelector("main")!.text).not.toContain("Everyone");
    // Pressing the lit Unassigned clears it.
    const lit = parse((await as(app, teamActor).get("/tickets?owner=none")).text);
    const unassigned = lit.querySelectorAll("nav[aria-label='Filter by owner'] a")[1]!;
    expect(unassigned.getAttribute("aria-current")).toBe("page");
    expect(unassigned.getAttribute("href")).toBe("/tickets");
  });

  it("gives a customer the search but not the owner chips", async () => {
    const { app } = await setup();
    const html = parse((await as(app, customerOne).get("/tickets")).text);
    expect(html.querySelector("nav[aria-label='Filter by owner']")).toBeNull();
    expect(html.querySelector("form.list-search input[name=q]")).not.toBeNull();
  });

  it("says when nothing matches, with a way back that keeps the status", async () => {
    const { app } = await setup();
    const html = parse((await as(app, teamActor).get("/tickets?status=new&owner=none&q=zzz")).text);
    const empty = html.querySelector("p.empty")!;
    expect(empty.text).toBe(
      'No new tickets that nobody owns and match "zzz". Clear the owner filter and search.',
    );
    expect(empty.querySelector("a")?.getAttribute("href")).toBe("/tickets?status=new");
  });
});

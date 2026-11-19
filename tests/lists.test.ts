import fs from "node:fs";
import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The ticket list as a first-time visitor meets it: named for whose tickets it holds, saying how
// a ticket moves through its statuses, and on the demo, filters that each visibly change the list.

function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}
const asDemo = (app: Express, id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
const keysOn = async (agent: ReturnType<typeof asDemo>, path: string) =>
  parse((await agent.get(path)).text)
    .querySelectorAll("table.tickets tbody tr td:first-child a")
    .map((a) => a.text);

describe("the ticket list", () => {
  it("is My tickets for a customer and All tickets for the team, with how statuses move", async () => {
    const { app } = buildTestApp();
    const mine = parse((await as(app, customerOne).get("/tickets")).text);
    expect(mine.querySelector("h1")?.text).toBe("My tickets");
    expect(mine.querySelector("title")?.text).toContain("My tickets");
    const all = parse((await as(app, teamActor).get("/tickets")).text);
    expect(all.querySelector("h1")?.text).toBe("All tickets");
    expect(all.querySelector(".list-note")?.text).toBe(
      "A ticket moves from New to In Progress, and is resolved when its customer confirms the fix or the team gives a reason.",
    );
    expect(all.querySelector(".role-note")).toBeNull();
  });

  it("tells an admin in one line what they can see and do", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    expect(html.querySelector("h1")?.text).toBe("All tickets");
    expect(html.querySelector(".role-note")?.text).toMatch(/^As an admin you see every ticket/);
  });

  it("tells the demo's admin the preview is read-only", async () => {
    const { app } = buildDemo();
    const html = parse((await asDemo(app, "demo-admin").get("/tickets")).text);
    expect(html.querySelector(".role-note")?.text).toMatch(/^Admin preview, read-only/);
  });

  it("links each title to its ticket, as well as its key", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x", fix_check: "Ten pages print" });
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    const link = html.querySelector("table.tickets td.title-cell a");
    expect(link?.text).toBe("Printer jams");
    expect(link?.getAttribute("href")).toBe("/tickets/SUP-1");
  });

  it("lets a long title wrap to two lines on a wide screen instead of cutting it off", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const wide = css.slice(css.indexOf("@media (min-width: 640px)"));
    const cell = /table\.tickets td\.user-text \{([^}]*)\}/.exec(wide)![1]!;
    expect(cell).not.toMatch(/nowrap|ellipsis/);
    expect(wide).toMatch(/table\.tickets td\.user-text a \{[^}]*-webkit-line-clamp: 2/);
  });
});

describe("the demo's samples", () => {
  it("come from several customers, so a customer's own list holds fewer than the team's", async () => {
    const { app } = buildDemo();
    const team = await keysOn(asDemo(app, "demo-team"), "/tickets");
    const customer = await keysOn(asDemo(app, "demo-customer"), "/tickets");
    expect(customer.length).toBeGreaterThan(0);
    expect(customer.length).toBeLessThan(team.length);
    for (const key of customer) expect(team).toContain(key);
  });

  it("hold every status, so each filter visibly changes the list", async () => {
    const { app } = buildDemo();
    const team = asDemo(app, "demo-team");
    const all = await keysOn(team, "/tickets");
    for (const status of ["new", "in_progress", "resolved"]) {
      const filtered = await keysOn(team, `/tickets?status=${status}`);
      expect(filtered.length, status).toBeGreaterThan(0);
      expect(filtered.length, status).toBeLessThan(all.length);
    }
  });
});

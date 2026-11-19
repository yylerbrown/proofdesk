import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, type Actor } from "../src/server/actor.js";
import { adminActor, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The header is two groups and nothing else. On the left, the brand and Tickets. On the right,
// New ticket and one menu named for the person, which holds everything about them.

const demoTeam = DEMO_ACTORS.find((who) => who.id === "demo-team")!;
const demoAdmin = DEMO_ACTORS.find((who) => who.readOnly === true)!;

/** The header as the given person sees it on /tickets. */
async function headerOf(who: Actor, env: Record<string, string> = {}) {
  const { app } = buildTestApp(env);
  const html = parse((await as(app, who).get("/tickets")).text);
  return html.querySelector("header nav")!;
}

/** The words of each row of the person menu, in order. */
function menuRows(nav: ReturnType<typeof parse>) {
  return nav
    .querySelectorAll(".person-menu > ul > li")
    .map((li) => li.querySelector("a, button, .role-current")?.text.trim() ?? li.text.trim());
}

const DEMO = { DEMO: "on", DEV_SIGN_IN: "off" };

describe("the header", () => {
  it("holds two groups: the brand and Tickets, then New ticket and the person menu", async () => {
    const nav = await headerOf(teamActor);
    const groups = nav.querySelectorAll(":scope > ul");
    expect(groups.length).toBe(2);
    expect(groups[0]!.querySelectorAll("a").map((a) => a.text.trim())).toEqual([
      "Proofdesk",
      "Tickets",
    ]);
    const right = groups[1]!.querySelectorAll(":scope > li");
    expect(right.length).toBe(2);
    expect(right[0]!.text.trim()).toBe("New ticket");
    expect(right[1]!.querySelector("details.person-menu summary strong")?.text).toBe("Team Member");
    expect(nav.text).not.toContain("Signed in as");
  });

  it("gives a team member Account and Sign out in the menu, and nothing else", async () => {
    expect(menuRows(await headerOf(teamActor))).toEqual(["Account", "Sign out"]);
    expect(menuRows(await headerOf(customerOne))).toEqual(["Account", "Sign out"]);
  });

  it("gives an admin People and Connections in the menu too", async () => {
    expect(menuRows(await headerOf(adminActor))).toEqual([
      "Account",
      "People",
      "Connections",
      "Sign out",
    ]);
  });

  it("names the demo's three people under Switch role, then Account, and nothing else", async () => {
    const nav = await headerOf(demoTeam, DEMO);
    expect(menuRows(nav)).toEqual([
      "Switch role",
      "Demo Customer",
      "Demo Team Member (you)",
      "Demo Admin (read-only)",
      "Account",
    ]);
    // No line under each name: the name is the whole choice.
    expect(nav.querySelector(".person-menu small")).toBeNull();
    // About this demo is in the footer of every page instead.
    expect(nav.text).not.toContain("About this demo");
  });

  it("gives the read-only admin preview no New ticket and no Connections", async () => {
    const nav = await headerOf(demoAdmin, DEMO);
    expect(nav.querySelector("a[href='/tickets/new']")).toBeNull();
    expect(menuRows(nav).slice(-3)).toEqual(["Demo Admin (read-only) (you)", "Account", "People"]);
  });

  it("names a demo person without a role word, and a real person with one", async () => {
    const demoSummary = (await headerOf(demoAdmin, DEMO)).querySelector(".person-menu summary")!;
    expect(demoSummary.text.trim()).toBe("Demo Admin (read-only)");
    expect(demoSummary.querySelector(".role-label")).toBeNull();
    const realSummary = (await headerOf(teamActor)).querySelector(".person-menu summary")!;
    expect(realSummary.querySelector(".role-label")?.text).toBe("Team member");
  });

  it("draws New ticket outlined, so a page's own next step is its only black button", async () => {
    const link = (await headerOf(teamActor)).querySelector("a[href='/tickets/new']")!;
    expect(link.getAttribute("role")).toBe("button");
    expect(link.classList.contains("outline")).toBe(true);
  });

  it("leaves New ticket out on the new ticket form itself", async () => {
    const { app } = buildTestApp();
    const form = await as(app, customerOne).get("/tickets/new").redirects(1);
    expect(parse(form.text).querySelector("header a[href='/tickets/new']")).toBeNull();
    // A refused filing shows the same form, still without it.
    const refused = await as(app, customerOne).post("/tickets").type("form").send({ title: "" });
    expect(refused.status).toBe(400);
    expect(parse(refused.text).querySelector("header a[href='/tickets/new']")).toBeNull();
  });
});

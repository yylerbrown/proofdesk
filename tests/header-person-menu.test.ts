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

  it("puts the demo's roles first and About this demo last, with no Sign out", async () => {
    expect(menuRows(await headerOf(demoTeam, DEMO))).toEqual([
      "Switch role",
      "View as Demo Customer",
      "Demo Team Member (you)",
      "Admin preview (read-only)",
      "Account",
      "About this demo",
    ]);
  });

  it("gives the read-only admin preview no New ticket and no Connections", async () => {
    const nav = await headerOf(demoAdmin, DEMO);
    expect(nav.querySelector("a[href='/tickets/new']")).toBeNull();
    expect(menuRows(nav).slice(-3)).toEqual(["Account", "People", "About this demo"]);
  });
});

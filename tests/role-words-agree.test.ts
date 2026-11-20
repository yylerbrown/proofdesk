import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { ROLE_LINES } from "../src/server/people/service.js";
import { ROLE_LABELS } from "../src/server/people/words.js";
import { can } from "../src/server/permissions.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// Every page names a role with the same words: "Customer", "Team member" and "Admin". The
// bylines and History use them too, and the lines that say what a role allows agree with the
// table the server checks.

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
}

describe("role words in bylines and History", () => {
  it("never read Demo Team Member team on the demo", async () => {
    const asDemo = demo();
    // Every seeded ticket the team can open, so a byline by the demo team member is met.
    let seen = 0;
    for (let number = 1; number <= 10; number += 1) {
      const res = await asDemo("demo-team").get(`/tickets/SUP-${number}`);
      if (res.status !== 200) continue;
      const page = parse(res.text);
      for (const header of page.querySelectorAll("article.entry header")) {
        if (header.querySelector("strong")?.text !== "Demo Team Member") continue;
        seen += 1;
        expect(header.text).not.toMatch(/\bteam\b/);
      }
      for (const cell of page.querySelectorAll("details.history tbody td:last-child")) {
        if (cell.text.includes("Demo Team Member"))
          expect(cell.text.trim()).toBe("Demo Team Member");
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it("print the role's page name after a name off the demo", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send({
      title: "The export button downloads an empty file",
      description: "Every export since Monday is empty.",
      fix_check: "An export of last week has rows in it.",
    });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Looking at it now." });
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const bylines = page.querySelectorAll("article.entry header small").map((small) => small.text);
    expect(bylines.some((text) => text.startsWith("Team member "))).toBe(true);
    const labels = page.querySelectorAll("details.history .role-label").map((label) => label.text);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(Object.values(ROLE_LABELS)).toContain(label);
  });
});

describe("the lines that say what a role allows", () => {
  it("never give the admin restore, which the team may do too", () => {
    const archived = { created_by: "someone", archived_at: "2026-11-20T00:00:00.000Z" };
    const team = { ...teamActor, demo: false };
    expect(can(team, "restore", archived)).toBe(true);
    expect(ROLE_LINES.admin).toBe("Admin: also deletes tickets and chooses who is on the team.");
  });

  it("show on the Account page for each person, under their role", async () => {
    const { app } = buildTestApp();
    const lines: Record<string, string> = {};
    for (const [name, person] of Object.entries({ customerOne, teamActor })) {
      const page = parse((await as(app, person).get("/account")).text);
      lines[name] = page.querySelector(".role-allows")?.text ?? "";
    }
    const adminPage = parse((await admin(app).get("/account")).text);
    lines.admin = adminPage.querySelector(".role-allows")?.text ?? "";
    expect(lines).toEqual({
      customerOne: "You file tickets, follow your own and say whether a fix worked.",
      teamActor: "You see every ticket and work on it with the team.",
      admin:
        "You do everything a team member does, and also delete tickets and choose who is on the team.",
    });
  });

  it("show the demo admin that it changes nothing", async () => {
    const page = parse((await demo()("demo-admin").get("/account")).text);
    expect(page.querySelector(".role-allows")?.text).toBe(
      "You see everything an admin sees, and change nothing.",
    );
  });
});

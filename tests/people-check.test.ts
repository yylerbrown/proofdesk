import type { Express } from "express";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { buildTestApp, visitor } from "./helpers.js";
import {
  browserOf,
  buildPeopleApp,
  changeCount,
  signedInPerson,
  storedRole,
} from "./people-helpers.js";

// "Check this change" on the People page: before a role changes, a page says what the change
// would do, worked out by the same checks as the change itself. On the demo it writes nothing
// and offers no button, so one visitor never changes what the next one sees.

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** What the check page says: its title, its lines, why it stops, its note and its button. */
function checkOf(html: string) {
  const main = parse(html).querySelector("main")!;
  return {
    question: main.querySelector("h1")?.text.trim() ?? null,
    happens: main.querySelectorAll(".role-check-happens li").map((li) => li.text.trim()),
    stop: main.querySelector(".role-check-stop")?.text.trim() ?? null,
    note: main.querySelector(".role-note")?.text.trim() ?? null,
    button: main.querySelector("form button")?.text.trim() ?? null,
    cancel: main.querySelector("form a")?.text.trim() ?? null,
  };
}

/** Opens the check of one role change, as the People page's choice does. */
function check(browser: ReturnType<typeof visitor>, person: string, role: string) {
  return browser.get("/people/check").query({ person, role });
}

/** How many assistant connections are still live. */
function liveConnections(db: ReturnType<typeof buildTestApp>["db"]): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM agent_connections WHERE revoked_at IS NULL")
    .get() as { n: number };
  return row.n;
}

async function setRole(app: Express, cookie: string, person: string, role: string) {
  const res = await browserOf(app, cookie).post("/people").type("form").send({ person, role });
  expect(res.status, res.text).toBe(303);
}

describe("checking a role change on the demo", () => {
  function demo() {
    const { app, db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const as = (id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
    return { app, db, as };
  }

  it("lists what would happen, offers no button, and writes nothing", async () => {
    const { db, as } = demo();
    const res = await check(as("demo-admin"), "demo-customer-2", "team");
    expect(res.status).toBe(200);
    expect(checkOf(res.text)).toEqual({
      question: "Make Second Demo Customer a team member?",
      happens: [
        "Second Demo Customer will work on every ticket and write internal notes from their next page.",
      ],
      stop: null,
      note:
        "Demo Admin (read-only) changes nothing, so there is no button here. " +
        "On the real site this is where the change is made.",
      button: null,
      cancel: null,
    });
    expect(parse(res.text).querySelector("main form")).toBeNull();
    expect(parse(res.text).querySelector('main a[href="/people"]')?.text).toBe("Back to People");
    expect(changeCount(db)).toBe(0);
    const stored = db.prepare("SELECT COUNT(*) AS n FROM people_roles").get() as { n: number };
    expect(stored.n).toBe(0);
    // The person is still a customer on the People page.
    const people = await as("demo-admin").get("/people");
    const row = parse(people.text)
      .querySelectorAll("table.people tbody tr")
      .find((tr) => tr.text.includes("Second Demo Customer"))!;
    expect(row.querySelector("option[selected]")?.getAttribute("value")).toBe("customer");
  });

  it("names the tickets the demo team member owns, from the real data", async () => {
    const { db, as } = demo();
    expect((await as("demo-customer").post("/api/tickets").send(valid)).status).toBe(201);
    const key = (db.prepare("SELECT MAX(id) AS id FROM tickets").get() as { id: number }).id;
    const taken = await as("demo-team").post(`/api/tickets/SUP-${key}/take-and-start`);
    expect(taken.status, taken.text).toBe(200);
    const res = await check(as("demo-admin"), "demo-team", "customer");
    expect(res.status).toBe(200);
    const page = checkOf(res.text);
    expect(page.stop).toContain("Demo Team Member still owns ");
    expect(page.stop).toContain(`SUP-${key}`);
    expect(page.stop).toContain("Hand ");
    expect(page.button).toBeNull();
    expect(changeCount(db)).toBe(0);
  });

  it("refuses the demo admin's own row and anyone not on the page", async () => {
    const { as } = demo();
    const self = await check(as("demo-admin"), "demo-admin", "customer");
    expect(self.status).toBe(403);
    expect(parse(self.text).querySelector("p.refused")?.text).toBe(
      "You cannot change your own role. Ask another admin.",
    );
    const nobody = await check(as("demo-admin"), "someone-else", "team");
    expect(nobody.status).toBe(404);
  });

  it.each(["demo-team", "demo-customer"])("is closed to %s", async (id) => {
    const { as } = demo();
    expect((await check(as(id), "demo-customer-2", "team")).status).toBe(403);
  });
});

describe("checking a role change on the real site", () => {
  async function site() {
    const built = buildPeopleApp();
    const { db, app } = built;
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const sam = await signedInPerson(db, "5005", "Sam Lee");
    const di = await signedInPerson(db, "5006", "Di Customer");
    return { ...built, ada, sam, di, boss: browserOf(app, ada.cookie) };
  }

  it("says what will happen, and its one button makes exactly that change", async () => {
    const { db, app, ada, sam, boss } = await site();
    const res = await check(boss, sam.id, "team");
    expect(res.status).toBe(200);
    expect(checkOf(res.text)).toEqual({
      question: "Make Sam Lee a team member?",
      happens: ["Sam Lee will work on every ticket and write internal notes from their next page."],
      stop: null,
      note: null,
      button: "Make Sam Lee a team member",
      cancel: "Cancel",
    });
    // Checking writes nothing.
    expect(storedRole(db, sam.id)).toBeNull();
    expect(changeCount(db)).toBe(0);
    // The button posts the same person and role to the People page.
    const form = parse(res.text).querySelector("main form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/people");
    const fields = Object.fromEntries(
      form
        .querySelectorAll("input[type=hidden]")
        .map((input) => [input.getAttribute("name"), input.getAttribute("value")]),
    );
    expect(fields).toEqual({ person: sam.id, role: "team" });
    await setRole(app, ada.cookie, sam.id, "team");
    expect(storedRole(db, sam.id)).toBe("team");
    expect(changeCount(db)).toBe(1);
  });

  it("counts the assistant connections that lowering an admin would revoke", async () => {
    const { db, app, ada, sam, boss } = await site();
    await setRole(app, ada.cookie, sam.id, "admin");
    for (const name of ["Night shift", "Day shift"]) {
      const made = await browserOf(app, sam.cookie)
        .post("/connections")
        .type("form")
        .send({ name, scopes: ["read_tickets"] });
      expect(made.status, made.text).toBe(200);
    }
    const res = await check(boss, sam.id, "team");
    expect(checkOf(res.text).happens).toEqual([
      "Sam Lee will work on every ticket and write internal notes from their next page.",
      "Their 2 assistant connections will be revoked.",
    ]);
    expect(checkOf(res.text).button).toBe("Make Sam Lee a team member");
    // Nothing was revoked by checking.
    expect(liveConnections(db)).toBe(2);
    expect(changeCount(db)).toBe(1);
    // Raising someone, or keeping an admin an admin, revokes nothing and says nothing of it.
    const same = await check(boss, sam.id, "admin");
    expect(checkOf(same.text)).toMatchObject({
      happens: [],
      stop: "Sam Lee is already an admin. Nothing would change.",
      button: null,
    });
  });

  it("names the tickets someone still owns and offers no button", async () => {
    const { db, app, ada, sam, di, boss } = await site();
    await setRole(app, ada.cookie, sam.id, "team");
    expect((await browserOf(app, di.cookie).post("/api/tickets").send(valid)).status).toBe(201);
    expect((await browserOf(app, di.cookie).post("/api/tickets").send(valid)).status).toBe(201);
    for (const key of ["SUP-1", "SUP-2"]) {
      const taken = await browserOf(app, sam.cookie).post(`/api/tickets/${key}/take-and-start`);
      expect(taken.status, taken.text).toBe(200);
    }
    const res = await check(boss, sam.id, "customer");
    expect(checkOf(res.text)).toEqual({
      question: "Make Sam Lee a customer?",
      happens: ["Sam Lee will see only their own tickets from their next page."],
      stop: "Sam Lee still owns SUP-1 and SUP-2. Hand them to someone else first.",
      note: null,
      button: null,
      cancel: null,
    });
    expect(parse(res.text).querySelector("main form")).toBeNull();
    expect(changeCount(db)).toBe(1);
  });

  it("refuses the admin's own role, in the People page's words", async () => {
    const { ada, boss } = await site();
    const self = await check(boss, ada.id, "customer");
    expect(self.status).toBe(403);
    expect(parse(self.text).querySelector("p.refused")?.text).toBe(
      "You cannot change your own role. Ask another admin.",
    );
  });

  it("refuses a person the server settings name, and a role that does not exist", async () => {
    const { db, boss } = await site();
    const bo = await signedInPerson(db, "2002", "Bo Team");
    const locked = await check(boss, bo.id, "customer");
    expect(locked.status).toBe(403);
    expect(parse(locked.text).querySelector("p.refused")?.text).toBe(
      "Bo Team is a team member by the server settings. Change TEAM_GITHUB_IDS to change that.",
    );
    const wrong = await check(boss, bo.id, "owner");
    expect(wrong.status).toBe(400);
  });

  it("is closed to a customer", async () => {
    const { app, sam, di } = await site();
    expect((await check(browserOf(app, di.cookie), sam.id, "team")).status).toBe(403);
  });
});

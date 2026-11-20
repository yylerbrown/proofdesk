import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import { WRITE_LIMIT } from "../src/server/limits.js";
import { openSite } from "../src/server/start.js";
import { buildTestApp, SIGN_IN_ENV, visitor } from "./helpers.js";
import {
  browserOf,
  buildPeopleApp,
  changeCount,
  signedInPerson,
  storedRole,
} from "./people-helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** A server with an admin, a team member named in the settings, and two customers. */
async function peopleApp() {
  const built = buildPeopleApp();
  const { db, app } = built;
  const ada = await signedInPerson(db, "1001", "Ada Admin");
  const max = await signedInPerson(db, "1002", "Max Admin");
  const bo = await signedInPerson(db, "2002", "Bo Team");
  const sam = await signedInPerson(db, "5005", "Sam Customer");
  const di = await signedInPerson(db, "5006", "Di Customer");
  return { ...built, ada, max, bo, sam, di, boss: browserOf(app, ada.cookie) };
}

/** Each row of the People page: the name, and what the role cell offers or says. */
function rowsOf(html: string) {
  return parse(html)
    .querySelectorAll("table.people tbody tr")
    .map((row) => {
      const cells = row.querySelectorAll("td");
      const select = row.querySelector("select");
      return {
        name: cells[0]!.querySelector(".person-name")!.text.trim(),
        email: cells[0]!.querySelector(".person-email")?.text.trim() ?? null,
        role: select
          ? (select.querySelector("option[selected]")?.getAttribute("value") ?? null)
          : null,
        disabled: select?.hasAttribute("disabled") ?? null,
        says: select ? null : cells[1]!.text.replace(/\s+/g, " ").trim(),
      };
    });
}

describe("the People page for an admin", () => {
  it("lists everyone who signed in, with locked rows saying why", async () => {
    const { boss } = await peopleApp();
    const res = await boss.get("/people");
    expect(res.status).toBe(200);
    expect(rowsOf(res.text)).toEqual([
      {
        name: "Ada Admin",
        email: "1001@example.com",
        role: null,
        disabled: null,
        says: "You, Admin",
      },
      {
        name: "Max Admin",
        email: "1002@example.com",
        role: null,
        disabled: null,
        says: "Admin, set in the server settings",
      },
      {
        name: "Bo Team",
        email: "2002@example.com",
        role: null,
        disabled: null,
        says: "Team member, set in the server settings",
      },
      {
        name: "Sam Customer",
        email: "5005@example.com",
        role: "customer",
        disabled: false,
        says: null,
      },
      {
        name: "Di Customer",
        email: "5006@example.com",
        role: "customer",
        disabled: false,
        says: null,
      },
    ]);
    expect(res.text).toContain("Team member: works on every ticket and writes internal notes.");
    // The role lines come after the table, and no role change means no record of them at all.
    const main = parse(res.text).querySelector("main")!.toString();
    expect(main.indexOf("role-lines")).toBeGreaterThan(main.indexOf("table"));
    expect(parse(res.text).querySelector(".role-changes")).toBeNull();
    expect(res.text).not.toContain("No role has been changed here yet.");
    // Two columns, and each person's first sign-in as quiet words under their name.
    expect(
      parse(res.text)
        .querySelectorAll("table.people th")
        .map((th) => th.text),
    ).toEqual(["Person", "Role"]);
    const since = parse(res.text).querySelectorAll("table.people td .person-since");
    expect(since).toHaveLength(5);
    expect(since[0]!.text).toMatch(/^First signed in /);
    expect(since[0]!.querySelector("time")).not.toBeNull();
  });

  it("keeps the order of signing in when two people signed in in the same millisecond", async () => {
    const { boss, db } = await peopleApp();
    db.prepare(`UPDATE "user" SET "createdAt" = ?`).run("2026-01-01T00:00:00.000Z");
    const res = await boss.get("/people");
    expect(rowsOf(res.text).map((row) => row.name)).toEqual([
      "Ada Admin",
      "Max Admin",
      "Bo Team",
      "Sam Customer",
      "Di Customer",
    ]);
  });

  it("says what changed after a save, once, and records it in the history", async () => {
    const { boss, sam } = await peopleApp();
    const saved = await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    expect(saved.status).toBe(303);
    expect(saved.headers.location).toBe("/people");
    const page = await boss.get("/people");
    expect(parse(page.text).querySelector("p.saved")?.text).toBe(
      "Sam Customer is now a team member.",
    );
    const changes = parse(page.text).querySelector("details.role-changes")!;
    expect(changes.hasAttribute("open")).toBe(false);
    expect(changes.querySelector("summary")?.text).toBe("Role changes (1)");
    expect(changes.querySelector("li span")?.text).toBe(
      "Ada Admin made Sam Customer a team member. Before: a customer.",
    );
    // A reload, or a link to the page, says nothing more.
    const reload = await boss.get("/people");
    expect(parse(reload.text).querySelectorAll("p.saved")).toHaveLength(0);
  });

  it("says nothing changed when the role chosen is the one they have", async () => {
    const { boss, sam } = await peopleApp();
    const saved = await boss
      .post("/people")
      .type("form")
      .send({ person: sam.id, role: "customer" });
    expect(saved.status).toBe(303);
    expect(([] as string[]).concat(saved.headers["set-cookie"] ?? []).join()).not.toContain(
      "people_changed",
    );
  });

  it("asks for a person when a hand-made request names nobody", async () => {
    const { boss } = await peopleApp();
    const res = await boss.post("/people").type("form").send({ role: "team" });
    expect(res.status).toBe(400);
    expect(parse(res.text).querySelector("p.refused")?.text).toContain("Choose a person.");
    expect(res.text).not.toContain("Invalid input");
  });

  it("asks for a person and a role when a hand-made request is not a form", async () => {
    const { boss, db, sam } = await peopleApp();
    const res = await boss
      .post("/people")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ person: sam.id, role: "team" }));
    expect(res.status).toBe(400);
    expect(parse(res.text).querySelector("p.refused")?.text).toContain(
      "Choose a person and a role.",
    );
    expect(res.text).not.toContain("Invalid input");
    expect(storedRole(db, sam.id)).toBeNull();
  });

  it("refuses a role that is not one of the three, and changes nothing", async () => {
    const { boss, db, sam } = await peopleApp();
    const res = await boss.post("/people").type("form").send({ person: sam.id, role: "owner" });
    expect(res.status).toBe(400);
    expect(parse(res.text).querySelector("p.refused")?.text).toContain(
      "Choose customer, team member or admin.",
    );
    expect(storedRole(db, sam.id)).toBeNull();
  });
});

describe("each change of role", () => {
  it("writes exactly one history row, and none when nothing changes", async () => {
    const { boss, db, sam } = await peopleApp();
    await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    expect(changeCount(db)).toBe(1);
    await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    expect(changeCount(db)).toBe(1);
    await boss.post("/people").type("form").send({ person: sam.id, role: "customer" });
    expect(changeCount(db)).toBe(2);
  });

  it("leaves a history row that cannot be edited or deleted", async () => {
    const { boss, db, sam } = await peopleApp();
    await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    expect(() => db.prepare("UPDATE role_changes SET to_role = 'admin'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM role_changes").run()).toThrow(/append-only/);
    expect(changeCount(db)).toBe(1);
  });
});

describe("rows that cannot change", () => {
  it("refuses a hand-made request to change your own role", async () => {
    const { boss, db, ada } = await peopleApp();
    const res = await boss.post("/people").type("form").send({ person: ada.id, role: "customer" });
    expect(res.status).toBe(403);
    expect(parse(res.text).querySelector("p.refused")?.text).toBe(
      "You cannot change your own role. Ask another admin.",
    );
    expect(storedRole(db, ada.id)).toBeNull();
    expect(changeCount(db)).toBe(0);
  });

  it("refuses a hand-made request to change someone named in the settings", async () => {
    const { boss, db, max, bo } = await peopleApp();
    const admin = await boss
      .post("/people")
      .type("form")
      .send({ person: max.id, role: "customer" });
    expect(admin.status).toBe(403);
    expect(parse(admin.text).querySelector("p.refused")?.text).toBe(
      "Max Admin is an admin by the server settings. Change ADMIN_GITHUB_IDS to change that.",
    );
    const team = await boss.post("/people").type("form").send({ person: bo.id, role: "admin" });
    expect(team.status).toBe(403);
    expect(storedRole(db, max.id)).toBeNull();
    expect(storedRole(db, bo.id)).toBeNull();
    expect(changeCount(db)).toBe(0);
  });

  it("refuses to take the team role from someone who owns open tickets, naming them", async () => {
    const { app, boss, db, sam, di } = await peopleApp();
    await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    const customer = browserOf(app, di.cookie);
    await customer.post("/api/tickets").send(valid);
    await customer.post("/api/tickets").send(valid);
    const samBrowser = browserOf(app, sam.cookie);
    expect((await samBrowser.post("/api/tickets/SUP-1/take")).status).toBe(200);
    expect((await samBrowser.post("/api/tickets/SUP-2/take")).status).toBe(200);

    const res = await boss.post("/people").type("form").send({ person: sam.id, role: "customer" });
    expect(res.status).toBe(409);
    expect(parse(res.text).querySelector("p.refused")?.text).toBe(
      "Sam Customer still owns SUP-1 and SUP-2. Hand them to someone else first.",
    );
    expect(storedRole(db, sam.id)).toBe("team");
    expect(changeCount(db)).toBe(1);
  });

  it("says when an owned ticket is archived, since it must be restored to hand it on", async () => {
    const { app, boss, db, sam, di } = await peopleApp();
    await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    await browserOf(app, di.cookie).post("/api/tickets").send(valid);
    expect((await browserOf(app, sam.cookie).post("/api/tickets/SUP-1/take")).status).toBe(200);
    db.prepare("UPDATE tickets SET archived_at = ? WHERE id = 1").run(new Date().toISOString());

    const res = await boss.post("/people").type("form").send({ person: sam.id, role: "customer" });
    expect(res.status).toBe(409);
    expect(parse(res.text).querySelector("p.refused")?.text).toBe(
      "Sam Customer still owns SUP-1. Hand it to someone else first. " +
        "SUP-1 is archived: restore before handing on.",
    );
    expect(storedRole(db, sam.id)).toBe("team");
  });

  it("refuses someone who never signed in here", async () => {
    const { boss, db } = await peopleApp();
    const res = await boss.post("/people").type("form").send({ person: "nobody", role: "team" });
    expect(res.status).toBe(404);
    expect(changeCount(db)).toBe(0);
  });
});

describe("anyone but an admin", () => {
  it.each(["bo", "sam"] as const)(
    "%s gets the admin-only refusal, and changes nothing",
    async (who) => {
      const built = await peopleApp();
      const browser = browserOf(built.app, built[who].cookie);
      const page = await browser.get("/people");
      expect(page.status).toBe(403);
      expect(page.text).toContain("Only an admin chooses who is on the team.");
      const post = await browser
        .post("/people")
        .type("form")
        .send({ person: built.di.id, role: "admin" });
      expect(post.status).toBe(403);
      expect(post.text).toContain("Only an admin chooses who is on the team.");
      expect(storedRole(built.db, built.di.id)).toBeNull();
    },
  );

  it("is sent to sign in when signed out", async () => {
    const { app, db, sam } = await peopleApp();
    const page = await visitor(app).get("/people");
    expect(page.status).toBe(303);
    expect(page.headers.location).toBe("/sign-in?next=%2Fpeople");
    const post = await visitor(app)
      .post("/people")
      .type("form")
      .send({ person: sam.id, role: "admin" });
    expect(post.status).toBe(303);
    expect(storedRole(db, sam.id)).toBeNull();
  });

  it("never reaches the page with an assistant's connection key", async () => {
    const { app, boss, db, sam } = await peopleApp();
    const issued = await boss
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
    const key = /pd_[0-9a-f]{8}_[A-Za-z0-9_-]{32}/.exec(issued.text)![0];
    const withKey = request(app).get("/people").set("Authorization", `Bearer ${key}`);
    expect((await withKey).status).toBe(303);
    const post = await visitor(app)
      .post("/people")
      .set("Authorization", `Bearer ${key}`)
      .type("form")
      .send({ person: sam.id, role: "admin" });
    expect(post.status).toBe(303);
    expect(storedRole(db, sam.id)).toBeNull();
  });
});

describe("a change of role", () => {
  it("is refused when it comes from another site", async () => {
    const { app, ada, db, sam } = await peopleApp();
    const res = await request(app)
      .post("/people")
      .set("Cookie", ada.cookie)
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send({ person: sam.id, role: "admin" });
    expect(res.status).toBe(403);
    expect(res.text).toContain("This request did not come from this site.");
    expect(storedRole(db, sam.id)).toBeNull();
  });

  it("counts towards the same write limit as every other form", async () => {
    const { boss, sam } = await peopleApp();
    for (let i = 0; i < WRITE_LIMIT; i++) {
      await boss.post("/people").type("form").send({ person: sam.id, role: "customer" });
    }
    const over = await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    expect(over.status).toBe(429);
  });
});

describe("the header's People link", () => {
  it("is shown to an admin and to nobody else", async () => {
    const { app, ada, bo, sam } = await peopleApp();
    const hasLink = async (cookie: string) =>
      parse((await browserOf(app, cookie).get("/tickets")).text).querySelector(
        "header a[href='/people']",
      ) !== null;
    expect(await hasLink(ada.cookie)).toBe(true);
    expect(await hasLink(bo.cookie)).toBe(false);
    expect(await hasLink(sam.cookie)).toBe(false);
  });
});

describe("on the demo", () => {
  function demoAs(id: string) {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    return { app, browser: visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`) };
  }

  it("shows the admin preview the made-up people, each with a change to check", async () => {
    const { browser } = demoAs("demo-admin");
    const res = await browser.get("/people");
    expect(res.status).toBe(200);
    const main = parse(res.text).querySelector("main")!;
    expect(main.querySelector("h1 + p")?.text).toBe("Choose who is on the support team.");
    expect(main.querySelector(".role-note")?.text).toBe(
      "Demo Admin (read-only) changes nothing here.",
    );
    expect(main.querySelectorAll("h2")).toHaveLength(0);
    const rows = rowsOf(res.text);
    expect(rows.map((row) => row.name)).toEqual([
      "Demo Customer",
      "Demo Team Member",
      "Demo Admin (read-only)",
      "Second Demo Customer",
      "Third Demo Customer",
    ]);
    // Each other person has a role choice that only opens its check. Nothing here saves.
    expect(rows.map((row) => row.role)).toEqual(["customer", "team", null, "customer", "customer"]);
    expect(rows.map((row) => row.says)).toEqual([null, null, "You, Admin", null, null]);
    const forms = parse(res.text).querySelectorAll("table.people form");
    expect(forms.map((form) => form.getAttribute("method"))).toEqual(["get", "get", "get", "get"]);
    expect(forms.map((form) => form.getAttribute("action"))).toEqual(
      Array(4).fill("/people/check"),
    );
    expect(
      parse(res.text)
        .querySelectorAll("table.people button")
        .map((button) => button.text),
    ).toEqual(Array(4).fill("Check this change"));
    // A made-up person has no address and never signed in, so nothing stands under the name.
    expect(rows.map((row) => row.email)).toEqual([null, null, null, null, null]);
    expect(res.text).not.toContain("Made up for the demo");
    expect(parse(res.text).querySelector("table.people .person-since")).toBeNull();
  });

  it("changes nothing for the demo admin", async () => {
    const { browser } = demoAs("demo-admin");
    const res = await browser
      .post("/people")
      .type("form")
      .send({ person: "demo-team", role: "customer" });
    expect(res.status).toBe(403);
    expect(parse(res.text).querySelector("p.refused")?.text).toBe(
      "The demo admin changes nothing.",
    );
  });

  it.each(["demo-team", "demo-customer"])("refuses %s", async (id) => {
    const { browser } = demoAs(id);
    expect((await browser.get("/people")).status).toBe(403);
  });
});

describe("on the development entrance", () => {
  function devAs(id: string) {
    const { app } = buildTestApp({ DEV_SIGN_IN: "on" });
    return visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
  }

  it("shows the made-up admin the made-up people, each with a change to check", async () => {
    const res = await devAs("dev-admin-1").get("/people");
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      "These people are made up for development and keep their roles. " +
        "People who sign in with GitHub appear here.",
    );
    expect(res.text).not.toContain("Nobody has signed in with GitHub yet.");
    const rows = rowsOf(res.text);
    expect(rows.map((row) => row.name)).toEqual([
      "Customer One",
      "Customer Two",
      "Team Member",
      "Admin",
    ]);
    expect(rows[0]!.email).toBeNull();
    expect(rows.map((row) => row.role)).toEqual(["customer", "customer", "team", null]);
    expect(rows.map((row) => row.says)).toEqual([null, null, null, "You, Admin"]);
    expect(parse(res.text).querySelector("table.people form")?.getAttribute("method")).toBe("get");
  });

  it("changes nothing, and says so", async () => {
    const res = await devAs("dev-admin-1")
      .post("/people")
      .type("form")
      .send({ person: "dev-team-1", role: "customer" });
    expect(res.status).toBe(403);
    expect(parse(res.text).querySelector("p.refused")?.text).toBe(
      "The made-up people of the development entrance keep their roles.",
    );
  });
});

describe("starting a server", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function start(env: NodeJS.ProcessEnv) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-people-"));
    dirs.push(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const site = openSite(
      loadConfig({ ...SIGN_IN_ENV, DATABASE_PATH: path.join(dir, "site.db"), ...env }),
      () => {},
    );
    site.db.close();
    return warn.mock.calls.map((call) => String(call[0]));
  }

  it("warns in one line when GitHub sign-in names no admin", () => {
    expect(start({})).toEqual([
      "No admin is named in ADMIN_GITHUB_IDS. " +
        "Set it to at least one GitHub user number, so the site always has an admin.",
    ]);
  });

  it("says nothing when an admin is named", () => {
    expect(start({ ADMIN_GITHUB_IDS: "1001" })).toEqual([]);
  });
});

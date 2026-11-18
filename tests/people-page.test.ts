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
        email: cells[0]!.querySelector(".person-email")!.text.trim(),
        role: select
          ? (select.querySelector("option[selected]")?.getAttribute("value") ?? null)
          : null,
        disabled: select?.hasAttribute("disabled") ?? null,
        says: select ? null : cells[2]!.text.replace(/\s+/g, " ").trim(),
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
    expect(res.text).toContain("No role has been changed here yet.");
    // Each row shows when that person first signed in.
    expect(parse(res.text).querySelectorAll("table.people time")).toHaveLength(5);
  });

  it("says what changed after a save, and records it in the history", async () => {
    const { boss, sam } = await peopleApp();
    const saved = await boss.post("/people").type("form").send({ person: sam.id, role: "team" });
    expect(saved.status).toBe(303);
    const page = await boss.get(saved.headers.location!);
    expect(parse(page.text).querySelector("p.saved")?.text).toBe(
      "Sam Customer is now a team member.",
    );
    expect(parse(page.text).querySelector("ul.role-changes li span")?.text).toBe(
      "Ada Admin made Sam Customer a team member. Before: a customer.",
    );
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

  it("shows the admin preview the three made-up people, with every choice disabled", async () => {
    const { browser } = demoAs("demo-admin");
    const res = await browser.get("/people");
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      "On the real site an admin changes roles here, and it applies at once. The demo admin changes nothing.",
    );
    const rows = rowsOf(res.text);
    expect(rows.map((row) => row.name)).toEqual([
      "Demo Customer",
      "Demo Team Member",
      "Demo Admin",
    ]);
    expect(rows.filter((row) => row.disabled === true)).toHaveLength(2);
    expect(rows[2]!.says).toBe("You, Admin");
    expect(parse(res.text).querySelector("table.people button:not([disabled])")).toBeNull();
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
      "No admin is named in ADMIN_GITHUB_IDS, so nobody can open the People page. " +
        "Set it to at least one GitHub user number.",
    ]);
  });

  it("says nothing when an admin is named", () => {
    expect(start({ ADMIN_GITHUB_IDS: "1001" })).toEqual([]);
  });
});

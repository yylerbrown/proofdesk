import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import type { Db } from "../src/server/db.js";
import { collectNotices, notifySettingsOf } from "../src/server/notify/outbox.js";
import { openSite } from "../src/server/start.js";
import { SIGN_IN_ENV, signedInLine } from "./helpers.js";
import {
  browserOf,
  buildPeopleApp,
  changeCount,
  signedInPerson,
  storedRole,
} from "./people-helpers.js";

// Taking a role away takes away what came with it. An owner notice quotes the customer, so it
// goes only to someone on the team at that moment. An assistant connection works only while
// the person who issued it is still an admin. And a role chosen on the People page cannot come
// back after the server settings stop naming the person.

const valid = { title: "Printer is broken", description: "It jams on every page." };

/** The server settings of buildPeopleApp, with changes. */
function peopleEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...SIGN_IN_ENV,
    DEV_SIGN_IN: "off",
    ADMIN_GITHUB_IDS: "1001,1002",
    TEAM_GITHUB_IDS: "2002",
    ...env,
  };
}

async function setRole(app: Express, cookie: string, person: string, role: string) {
  const res = await browserOf(app, cookie).post("/people").type("form").send({ person, role });
  expect(res.status, res.text).toBe(303);
}

/** Collects the notices of everything so far, as a server with a mail server would. */
function collect(db: Db, env: NodeJS.ProcessEnv = peopleEnv()) {
  collectNotices(db, { ...notifySettingsOf(loadConfig(env)), mailConfigured: true });
}

/** The kinds of notice written for one person, oldest first. */
function noticesTo(db: Db, personId: string): string[] {
  const rows = db
    .prepare("SELECT kind FROM email_outbox WHERE recipient_id = ? ORDER BY id")
    .all(personId) as { kind: string }[];
  return rows.map((row) => row.kind);
}

describe("a team member made a customer again", () => {
  it("gets no more owner notices about the tickets they owned", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const sam = await signedInPerson(db, "5005", "Sam Helper");
    const di = await signedInPerson(db, "5006", "Di Customer");
    const samBrowser = browserOf(app, sam.cookie);
    const diBrowser = browserOf(app, di.cookie);
    await setRole(app, ada.cookie, sam.id, "team");
    expect((await diBrowser.post("/api/tickets").send(valid)).status).toBe(201);
    expect((await samBrowser.post("/api/tickets/SUP-1/take-and-start")).status).toBe(200);
    const resolved = await samBrowser
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "wont_fix", note: "Works as designed." });
    expect(resolved.status).toBe(200);
    collect(db);
    const before = noticesTo(db, sam.id);

    // Every ticket Sam owns is resolved, so Sam may be made a customer, and stays its owner.
    await setRole(app, ada.cookie, sam.id, "customer");
    const reopened = await diBrowser
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It still jams on page two." });
    expect(reopened.status).toBe(200);
    const replied = await diBrowser
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Here is a photo of the jam." });
    expect(replied.status).toBe(201);
    collect(db);

    expect(noticesTo(db, sam.id)).toEqual(before);
    expect((await samBrowser.get("/api/tickets/SUP-1")).status).toBe(404);
  });

  it("gets none once the server settings stop naming them", async () => {
    const { app, db } = buildPeopleApp();
    const bo = await signedInPerson(db, "2002", "Bo Team");
    const di = await signedInPerson(db, "5006", "Di Customer");
    const diBrowser = browserOf(app, di.cookie);
    await diBrowser.post("/api/tickets").send(valid);
    expect((await browserOf(app, bo.cookie).post("/api/tickets/SUP-1/take")).status).toBe(200);
    collect(db);
    await diBrowser.post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "Any news?" });

    // The operator takes Bo out of TEAM_GITHUB_IDS and restarts. Bo still owns SUP-1.
    collect(db, peopleEnv({ TEAM_GITHUB_IDS: "" }));
    expect(noticesTo(db, bo.id)).not.toContain("customer_replied");
  });
});

/** Issues a connection as this admin on the connections page, and returns its key and id. */
async function issueConnection(app: Express, db: Db, cookie: string) {
  const page = await browserOf(app, cookie)
    .post("/connections")
    .type("form")
    .send({ name: "Night shift", scopes: ["read_tickets", "read_notes"] });
  expect(page.status, page.text).toBe(200);
  const key = keyOnPage(page.text);
  const row = db.prepare("SELECT id FROM agent_connections ORDER BY id DESC LIMIT 1").get() as {
    id: number;
  };
  return { key, id: row.id };
}

function withKey(app: Express, key: string) {
  return request(app).get("/api/tickets").set("Authorization", `Bearer ${key}`);
}

/** An MCP request with this key: the first message a client sends. */
function mcpWithKey(app: Express, key: string) {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${key}`)
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });
}

describe("an admin whose role is lowered", () => {
  it("loses the assistant connections they issued, and the People page says so", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const sam = await signedInPerson(db, "5005", "Sam Helper");
    await setRole(app, ada.cookie, sam.id, "admin");
    await browserOf(app, ada.cookie).post("/api/tickets").send(valid);
    const { key, id } = await issueConnection(app, db, sam.cookie);
    const samBrowser = browserOf(app, sam.cookie);
    expect((await samBrowser.post("/api/tickets/SUP-1/take-and-start")).status).toBe(200);
    expect(
      (await samBrowser.post("/api/tickets/SUP-1/agent").send({ connection_id: id })).status,
    ).toBe(200);
    expect((await withKey(app, key)).status).toBe(200);
    expect((await mcpWithKey(app, key)).status).toBe(200);

    // The same browser saves and then reads the page, as an admin's would.
    const boss = browserOf(app, ada.cookie);
    expect(
      (await boss.post("/people").type("form").send({ person: sam.id, role: "team" })).status,
    ).toBe(303);

    const refused = await withKey(app, key);
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe("invalid_connection_key");
    expect((await mcpWithKey(app, key)).status).toBe(401);
    const row = db.prepare("SELECT revoked_at FROM agent_connections WHERE id = ?").get(id) as {
      revoked_at: string | null;
    };
    expect(row.revoked_at).not.toBeNull();
    const people = await boss.get("/people");
    expect(people.text).toContain(
      "Sam Helper is now a team member. Their 1 assistant connection was revoked.",
    );
    // Nobody can hand a ticket to it any more.
    const handed = await browserOf(app, ada.cookie)
      .post("/api/tickets/SUP-1/agent")
      .send({ connection_id: id });
    expect(handed.status).toBeGreaterThanOrEqual(400);
  });

  it("finds their key refused once the server settings stop naming them an admin", async () => {
    const { app, db } = buildPeopleApp({ ADMIN_GITHUB_IDS: "1001,1002,5005" });
    const sam = await signedInPerson(db, "5005", "Sam Helper");
    const { key } = await issueConnection(app, db, sam.cookie);
    expect((await withKey(app, key)).status).toBe(200);

    // The operator takes Sam out of ADMIN_GITHUB_IDS and restarts on the same database.
    const restarted = createApp(loadConfig(peopleEnv()), db);
    expect((await withKey(restarted, key)).status).toBe(401);
  });
});

describe("a role chosen on the People page for someone the settings later name", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is forgotten at start-up, so it cannot come back when the settings stop naming them", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-sweep-"));
    dirs.push(dir);
    const databasePath = path.join(dir, "site.db");
    const start = (env: NodeJS.ProcessEnv = {}) =>
      openSite(loadConfig(peopleEnv({ DATABASE_PATH: databasePath, ...env })), () => {});

    const first = start();
    const ada = await signedInPerson(first.db, "1001", "Ada Admin");
    const sam = await signedInPerson(first.db, "5005", "Sam Helper");
    await setRole(first.app, ada.cookie, sam.id, "admin");
    expect(storedRole(first.db, sam.id)).toBe("admin");
    const changesBefore = changeCount(first.db);
    first.db.close();

    // The operator names Sam in TEAM_GITHUB_IDS and restarts.
    const second = start({ TEAM_GITHUB_IDS: "2002,5005" });
    expect(storedRole(second.db, sam.id)).toBeNull();
    expect(changeCount(second.db)).toBe(changesBefore + 1);
    const people = await browserOf(second.app, ada.cookie).get("/people");
    expect(people.text).toContain("The server settings made Sam Helper a team member.");
    second.db.close();

    // Then takes Sam out of the settings again and restarts: Sam is a customer.
    const third = start();
    const samBrowser = browserOf(third.app, sam.cookie);
    expect((await samBrowser.get("/tickets")).text).toContain(
      signedInLine("Sam Helper", "customer"),
    );
    expect((await samBrowser.get("/people")).status).toBe(403);
    third.db.close();
  });
});

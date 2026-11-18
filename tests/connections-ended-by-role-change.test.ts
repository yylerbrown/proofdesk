import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { parse } from "node-html-parser";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import type { Db } from "../src/server/db.js";
import { openSite } from "../src/server/start.js";
import { SIGN_IN_ENV } from "./helpers.js";
import { browserOf, buildPeopleApp, signedInPerson } from "./people-helpers.js";

// A connection that stopped working says so on the Connections page, and says why. When the
// person who issued it stops being an admin, it ends: on the People page at once, and at
// start-up when the server settings stop naming them. It is then listed as revoked with its
// reason, and no ticket can be handed to it. A plain Revoke gives no reason.

const valid = { title: "Printer is broken", description: "It jams on every page." };
const SAM_ENDED = "Ended when Sam Helper stopped being an admin.";

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

/** Issues a connection as this admin on the Connections page, and returns its id. */
async function issueConnection(app: Express, db: Db, cookie: string, name: string) {
  const page = await browserOf(app, cookie)
    .post("/connections")
    .type("form")
    .send({ name, scopes: ["read_tickets"] });
  expect(page.status, page.text).toBe(200);
  const row = db.prepare("SELECT id FROM agent_connections ORDER BY id DESC LIMIT 1").get() as {
    id: number;
  };
  return row.id;
}

/** The text of the State cell of one connection's row on the Connections page. */
async function stateOnList(app: Express, cookie: string, id: number): Promise<string> {
  const page = await browserOf(app, cookie).get("/connections");
  expect(page.status).toBe(200);
  const link = parse(page.text).querySelector(`a[href="/connections/${id}"]`);
  const row = link!.closest("tr")!;
  return row.querySelectorAll("td").at(-1)!.text.replace(/\s+/g, " ").trim();
}

/** The text of one connection's own page. */
async function ownPage(app: Express, cookie: string, id: number): Promise<string> {
  const page = await browserOf(app, cookie).get(`/connections/${id}`);
  expect(page.status).toBe(200);
  return parse(page.text).text.replace(/\s+/g, " ");
}

describe("a connection whose issuer the server settings stop naming as an admin", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is ended at start-up, listed as ended with its reason, and refused as a hand-off", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-ended-"));
    dirs.push(dir);
    const databasePath = path.join(dir, "site.db");
    const start = (env: NodeJS.ProcessEnv = {}) =>
      openSite(loadConfig(peopleEnv({ DATABASE_PATH: databasePath, ...env })), () => {});

    const first = start({ ADMIN_GITHUB_IDS: "1001,1002,5005" });
    const ada = await signedInPerson(first.db, "1001", "Ada Admin");
    const sam = await signedInPerson(first.db, "5005", "Sam Helper");
    const samsId = await issueConnection(first.app, first.db, sam.cookie, "Night shift");
    const adasId = await issueConnection(first.app, first.db, ada.cookie, "Day shift");
    first.db.close();

    // The operator takes Sam out of ADMIN_GITHUB_IDS and restarts on the same database.
    const second = start();
    const row = second.db
      .prepare("SELECT revoked_at, revoked_reason FROM agent_connections WHERE id = ?")
      .get(samsId) as { revoked_at: string | null; revoked_reason: string | null };
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_reason).toBe(SAM_ENDED);

    expect(await stateOnList(second.app, ada.cookie, samsId)).toBe(`Revoked ${SAM_ENDED}`);
    expect(await ownPage(second.app, ada.cookie, samsId)).toContain(SAM_ENDED);
    // A connection whose issuer is still an admin is left alone.
    expect(await stateOnList(second.app, ada.cookie, adasId)).toBe("Revoke");

    // The ticket's owner cannot hand it to the ended connection, only to the live one.
    const boss = browserOf(second.app, ada.cookie);
    expect((await boss.post("/api/tickets").send(valid)).status).toBe(201);
    expect((await boss.post("/api/tickets/SUP-1/take-and-start")).status).toBe(200);
    const refused = await boss.post("/api/tickets/SUP-1/agent").send({ connection_id: samsId });
    expect(refused.status).toBe(400);
    const handed = await boss.post("/api/tickets/SUP-1/agent").send({ connection_id: adasId });
    expect(handed.status).toBe(200);
    second.db.close();

    // Another restart changes nothing more.
    const third = start();
    const again = third.db
      .prepare("SELECT revoked_at FROM agent_connections WHERE id = ?")
      .get(samsId) as { revoked_at: string };
    expect(again.revoked_at).toBe(row.revoked_at);
    third.db.close();
  });
});

describe("the reason a connection ended", () => {
  it("is shown when the People page lowered its issuer's role", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const sam = await signedInPerson(db, "5005", "Sam Helper");
    const made = await browserOf(app, ada.cookie)
      .post("/people")
      .type("form")
      .send({ person: sam.id, role: "admin" });
    expect(made.status).toBe(303);
    const id = await issueConnection(app, db, sam.cookie, "Night shift");

    const lowered = await browserOf(app, ada.cookie)
      .post("/people")
      .type("form")
      .send({ person: sam.id, role: "team" });
    expect(lowered.status).toBe(303);

    expect(await stateOnList(app, ada.cookie, id)).toBe(`Revoked ${SAM_ENDED}`);
    expect(await ownPage(app, ada.cookie, id)).toContain(SAM_ENDED);
  });

  it("is not given when an admin pressed Revoke", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const id = await issueConnection(app, db, ada.cookie, "Night shift");

    const revoked = await browserOf(app, ada.cookie).post(`/connections/${id}/revoke`);
    expect(revoked.status).toBe(303);

    expect(await stateOnList(app, ada.cookie, id)).toBe("Revoked");
    expect(await ownPage(app, ada.cookie, id)).not.toContain("Ended when");
  });
});

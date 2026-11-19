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

// When an assistant connection ends, any ticket handed to it stops being handed to it, with a
// history entry, so no ticket waits on an assistant that can never answer. A connection ends
// when an admin revokes it, when the People page lowers its issuer's role, or at start-up when
// the server settings stop naming its issuer as an admin.

const valid = { title: "Printer is broken", description: "It jams on every page." };

function peopleEnv(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...SIGN_IN_ENV,
    DEV_SIGN_IN: "off",
    ADMIN_GITHUB_IDS: "1001,1002",
    TEAM_GITHUB_IDS: "2002",
    ...env,
  };
}

/** Issues a connection as this admin, files SUP-1, takes it and hands it to the connection. */
async function handedToNewConnection(app: Express, db: Db, cookie: string): Promise<number> {
  const browser = browserOf(app, cookie);
  await browser
    .post("/connections")
    .type("form")
    .send({ name: "Night shift", scopes: ["read_tickets"] });
  const { id } = db.prepare("SELECT id FROM agent_connections ORDER BY id DESC LIMIT 1").get() as {
    id: number;
  };
  expect((await browser.post("/api/tickets").send(valid)).status).toBe(201);
  expect((await browser.post("/api/tickets/SUP-1/take-and-start")).status).toBe(200);
  expect((await browser.post("/api/tickets/SUP-1/agent").send({ connection_id: id })).status).toBe(
    200,
  );
  return id;
}

/** True while SUP-1 is still handed to an assistant. */
function stillHanded(db: Db): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM ticket_agent_handoffs WHERE ended_at IS NULL")
    .get() as { n: number };
  return row.n > 0;
}

/** SUP-1's history as the team's page shows it. */
async function historyText(app: Express, cookie: string): Promise<string> {
  const page = await browserOf(app, cookie).get("/tickets/SUP-1");
  return parse(page.text).text.replace(/\s+/g, " ");
}

const ENDED_LINE = "Night shift (AI assistant) stopped working on it: its connection ended";

describe("a ticket handed to an assistant whose connection ends", () => {
  it("stops being handed to it when an admin revokes the connection", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const id = await handedToNewConnection(app, db, ada.cookie);
    expect(stillHanded(db)).toBe(true);

    await browserOf(app, ada.cookie).post(`/connections/${id}/revoke`);

    expect(stillHanded(db)).toBe(false);
    const events = (await browserOf(app, ada.cookie).get("/api/tickets/SUP-1/events")).body;
    expect(events.at(-1)).toMatchObject({
      type: "agent_handoff_ended",
      actor: ada.id,
      data: { connection: "Night shift", reason: "its connection ended" },
    });
    expect(await historyText(app, ada.cookie)).toContain(ENDED_LINE);
  });

  it("stops being handed to it when the People page lowers the issuer's role", async () => {
    const { app, db } = buildPeopleApp();
    const ada = await signedInPerson(db, "1001", "Ada Admin");
    const sam = await signedInPerson(db, "5005", "Sam Helper");
    await browserOf(app, ada.cookie)
      .post("/people")
      .type("form")
      .send({ person: sam.id, role: "admin" });
    await handedToNewConnection(app, db, sam.cookie);

    await browserOf(app, ada.cookie)
      .post("/people")
      .type("form")
      .send({ person: sam.id, role: "team" });

    expect(stillHanded(db)).toBe(false);
    expect(await historyText(app, sam.cookie)).toContain(ENDED_LINE);
  });

  describe("when the server settings stop naming the issuer as an admin", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("stops being handed to it at start-up, by the server settings", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-handoff-"));
      dirs.push(dir);
      const databasePath = path.join(dir, "site.db");
      const start = (env: NodeJS.ProcessEnv = {}) =>
        openSite(loadConfig(peopleEnv({ DATABASE_PATH: databasePath, ...env })), () => {});

      const first = start({ ADMIN_GITHUB_IDS: "1001,1002,5005" });
      const sam = await signedInPerson(first.db, "5005", "Sam Helper");
      await handedToNewConnection(first.app, first.db, sam.cookie);
      first.db.close();

      // Sam stays on the team, so Sam can still open the ticket.
      const second = start({ TEAM_GITHUB_IDS: "2002,5005" });
      expect(stillHanded(second.db)).toBe(false);
      const history = await historyText(second.app, sam.cookie);
      expect(history).toContain(ENDED_LINE);
      expect(history).toContain("The server settings");
      second.db.close();
    });
  });
});

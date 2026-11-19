import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { openSite } from "../src/server/start.js";
import { SIGN_IN_ENV } from "./helpers.js";
import { browserOf, signedInPerson } from "./people-helpers.js";

// When start-up ends assistant connections because their issuer is no longer an admin, the
// server log says so in one line with the count, so the operator knows why they stopped.

/** Issues a connection as this admin on the Connections page. */
async function issueConnection(app: Express, cookie: string, name: string) {
  const page = await browserOf(app, cookie)
    .post("/connections")
    .type("form")
    .send({ name, scopes: ["read_tickets"] });
  expect(page.status, page.text).toBe(200);
}

describe("start-up, after an admin is taken out of the server settings", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("logs one line with how many of their assistant connections it ended", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-ended-log-"));
    dirs.push(dir);
    const lines: string[] = [];
    const start = (admins: string) => {
      const env = {
        ...SIGN_IN_ENV,
        DEV_SIGN_IN: "off",
        ADMIN_GITHUB_IDS: admins,
        DATABASE_PATH: path.join(dir, "site.db"),
      };
      lines.length = 0;
      return openSite(loadConfig(env), (line) => lines.push(line));
    };

    const first = start("1001,5005");
    const sam = await signedInPerson(first.db, "5005", "Sam Helper");
    await issueConnection(first.app, sam.cookie, "Night shift");
    await issueConnection(first.app, sam.cookie, "Day shift");
    first.db.close();

    // The operator takes Sam out of ADMIN_GITHUB_IDS and restarts on the same database.
    const second = start("1001");
    expect(lines).toContain("Ended 2 assistant connections whose issuer is no longer an admin.");
    second.db.close();

    // Nothing is left to end, so the next start-up says nothing about it.
    const third = start("1001");
    expect(lines.filter((line) => line.startsWith("Ended "))).toEqual([]);
    third.db.close();
  });
});

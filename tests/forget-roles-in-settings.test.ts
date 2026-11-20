import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import type { Db } from "../src/server/db.js";
import { forgetRolesNamedInSettings } from "../src/server/people/service.js";
import { buildTestApp, SIGN_IN_ENV } from "./helpers.js";
import { changeCount, storedRole } from "./people-helpers.js";

// At start-up the server forgets a role chosen on the People page for anyone the server
// settings now name, so an old choice cannot come back when the settings stop naming them.
// It records a history line only when the forgotten role differs from the settings' role.

const config = loadConfig({
  ...SIGN_IN_ENV,
  DEV_SIGN_IN: "off",
  ADMIN_GITHUB_IDS: "1001",
  TEAM_GITHUB_IDS: "2002",
});

/** A person with a chosen role, signed in with GitHub (or with no GitHub account at all). */
function addPerson(db: Db, id: string, githubId: string | null, chosen: string) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, `Person ${id}`, `${id}@example.com`, now, now);
  if (githubId !== null) {
    db.prepare(
      `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES (?, ?, 'github', ?, ?, ?)`,
    ).run(`account-${id}`, githubId, id, now, now);
  }
  db.prepare("INSERT INTO people_roles (person_id, role, updated_at) VALUES (?, ?, ?)").run(
    id,
    chosen,
    now,
  );
}

describe("forgetting roles the server settings now name", () => {
  it("keeps the choice for someone with no GitHub account", () => {
    const { db } = buildTestApp();
    addPerson(db, "no-github", null, "team");
    expect(forgetRolesNamedInSettings(db, config)).toBe(0);
    expect(storedRole(db, "no-github")).toBe("team");
    expect(changeCount(db)).toBe(0);
  });

  it("keeps the choice for someone the settings do not name", () => {
    const { db } = buildTestApp();
    addPerson(db, "not-named", "3003", "admin");
    expect(forgetRolesNamedInSettings(db, config)).toBe(0);
    expect(storedRole(db, "not-named")).toBe("admin");
  });

  it("forgets a choice equal to the settings' role without a history line", () => {
    const { db } = buildTestApp();
    addPerson(db, "same", "2002", "team");
    expect(forgetRolesNamedInSettings(db, config)).toBe(1);
    expect(storedRole(db, "same")).toBeNull();
    expect(changeCount(db)).toBe(0);
  });

  it("forgets a different choice and records it as the server settings' change", () => {
    const { db } = buildTestApp();
    addPerson(db, "different", "1001", "customer");
    addPerson(db, "kept", "3003", "team");
    expect(forgetRolesNamedInSettings(db, config)).toBe(1);
    expect(storedRole(db, "different")).toBeNull();
    expect(storedRole(db, "kept")).toBe("team");
    const line = db
      .prepare("SELECT changed_by_name, from_role, to_role FROM role_changes WHERE person_id = ?")
      .get("different");
    expect(line).toEqual({
      changed_by_name: "The server settings",
      from_role: "customer",
      to_role: "admin",
    });
  });
});

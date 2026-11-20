import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import type { Db } from "../src/server/db.js";
import { HttpError } from "../src/server/errors.js";
import { createAccountService } from "../src/server/people/account.js";
import { roleNowOf } from "../src/server/people/role-now.js";
import { buildTestApp, customerOne, SIGN_IN_ENV, teamActor } from "./helpers.js";

// The account page's rules, called on the account service: only a person has one, where the
// address comes from, how they signed in on a site with two ways in, and saving the switch.
// Also roleNowOf, the one answer to a person's role at this moment.

const GITHUB_SITE = { ...SIGN_IN_ENV, DEV_SIGN_IN: "off", ADMIN_GITHUB_IDS: "1001" };
const BOTH_WAYS = {
  ...GITHUB_SITE,
  MICROSOFT_CLIENT_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  MICROSOFT_CLIENT_SECRET: "made-up-microsoft-secret",
  MICROSOFT_TENANT_ID: "11111111-2222-4333-8444-555555555555",
};

/** A person in the database, with an account for this way in, or none. */
function addPerson(db: Db, id: string, way: "github" | "microsoft" | null, accountId = "3003") {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, `Person ${id}`, `${id}@example.com`, now, now);
  if (way !== null) {
    db.prepare(
      `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`account-${id}`, accountId, way, id, now, now);
  }
  const actor: Actor = { id, kind: "person", role: "customer", name: `Person ${id}` };
  return actor;
}

const ASSISTANT: Actor = {
  id: "connection-1",
  kind: "agent",
  role: "team",
  name: "Helper",
  scopes: ["read_tickets"],
};

function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Expected the call to be refused");
}

describe("the account page", () => {
  it("is refused to an assistant's connection, for reading and for saving", () => {
    const { db } = buildTestApp();
    const account = createAccountService(db, loadConfig(GITHUB_SITE));
    for (const call of [() => account.page(ASSISTANT), () => account.setEmailMe(ASSISTANT, {})]) {
      const error = refusal(call);
      expect(error.status).toBe(403);
      expect(error.message).toContain("no account page");
    }
  });

  it("gives no source for an address when no known way in is on record", () => {
    const { db } = buildTestApp();
    const person = addPerson(db, "no-way", null);
    const page = createAccountService(db, loadConfig(GITHUB_SITE)).page(person);
    expect(page.email).toBe("no-way@example.com");
    expect(page.emailFrom).toBeNull();
    expect(page.signedInWith).toBeNull();
  });

  it("names how each person signed in on a site with both ways in", () => {
    const { db } = buildTestApp();
    const config = loadConfig(BOTH_WAYS);
    const viaGithub = addPerson(db, "via-github", "github");
    const viaMicrosoft = addPerson(db, "via-microsoft", "microsoft", "ms-1");
    const account = createAccountService(db, config);
    expect(account.page(viaGithub).signedInWith).toBe("GitHub");
    expect(account.page(viaMicrosoft).signedInWith).toBe("Microsoft");
    expect(account.page(viaMicrosoft).emailFrom).toContain("Microsoft account");
  });

  it("does not name the way in on a site with only GitHub", () => {
    const { db } = buildTestApp();
    const viaGithub = addPerson(db, "via-github", "github");
    const page = createAccountService(db, loadConfig(GITHUB_SITE)).page(viaGithub);
    expect(page.signedInWith).toBeNull();
    expect(page.emailFrom).toContain("GitHub account");
  });

  it("saves the switch as off when the form sends nothing at all", () => {
    const { db } = buildTestApp();
    const account = createAccountService(db, loadConfig({ DEV_SIGN_IN: "on" }));
    expect(account.page(customerOne).emailMe).toBe(true);
    account.setEmailMe(customerOne, undefined);
    expect(account.page(customerOne).emailMe).toBe(false);
    account.setEmailMe(customerOne, { email_me: "on" });
    expect(account.page(customerOne).emailMe).toBe(true);
  });

  it("refuses a value the checkbox never sends", () => {
    const { db } = buildTestApp();
    const account = createAccountService(db, loadConfig({ DEV_SIGN_IN: "on" }));
    expect(refusal(() => account.setEmailMe(customerOne, { email_me: "yes" })).status).toBe(400);
  });

  it("refuses the switch to the read-only admin", () => {
    const { db } = buildTestApp();
    const account = createAccountService(db, loadConfig({ DEV_SIGN_IN: "on" }));
    const readOnly: Actor = { ...teamActor, readOnly: true };
    expect(refusal(() => account.setEmailMe(readOnly, {})).status).toBe(403);
    expect(account.page(readOnly).canChangeEmailMe).toBe(false);
  });
});

describe("a person's role at this moment", () => {
  it("is undefined for an id that belongs to nobody", () => {
    const { db } = buildTestApp();
    expect(roleNowOf(loadConfig(GITHUB_SITE), db, "deleted-person")).toBeUndefined();
  });

  it("is the made-up person's own on the development entrance", () => {
    const { db } = buildTestApp();
    expect(roleNowOf(loadConfig({ DEV_SIGN_IN: "on" }), db, teamActor.id)).toBe("team");
  });

  it("is the settings' role first, then the chosen role, then customer", () => {
    const { db } = buildTestApp();
    const config = loadConfig(GITHUB_SITE);
    addPerson(db, "named", "github", "1001");
    addPerson(db, "chosen", "github", "3003");
    addPerson(db, "plain", "github", "4004");
    db.prepare("INSERT INTO people_roles (person_id, role, updated_at) VALUES (?, ?, ?)").run(
      "chosen",
      "team",
      new Date().toISOString(),
    );
    expect(roleNowOf(config, db, "named")).toBe("admin");
    expect(roleNowOf(config, db, "chosen")).toBe("team");
    expect(roleNowOf(config, db, "plain")).toBe("customer");
  });
});

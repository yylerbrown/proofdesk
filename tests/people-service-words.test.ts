import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import { createConnectionService } from "../src/server/connections/service.js";
import type { Db } from "../src/server/db.js";
import { HttpError } from "../src/server/errors.js";
import { createPeopleService } from "../src/server/people/service.js";
import { adminActor, as, buildTestApp, customerOne, SIGN_IN_ENV, teamActor } from "./helpers.js";

// The rules of the People page, called on the people service itself: who may look, who may
// be changed, what a role change would do (previewRoleChange) and what changeRole then does.
// Each test files its tickets through the development entrance, then reads the same database
// with the settings of a real site, where people sign in with GitHub.

/** A real site's settings: GitHub sign-in, user 1001 an admin and 2002 a team member. */
const REAL_SITE = {
  ...SIGN_IN_ENV,
  DEV_SIGN_IN: "off",
  ADMIN_GITHUB_IDS: "1001",
  TEAM_GITHUB_IDS: "2002",
};

/** Puts a person who signed in with GitHub into the database and returns them as an actor. */
function addPerson(db: Db, id: string, name: string, githubId: string, role: Actor["role"]) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, ?, ?, 1, ?, ?)`,
  ).run(id, name, `${id}@example.com`, now, now);
  db.prepare(
    `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
     VALUES (?, ?, 'github', ?, ?, ?)`,
  ).run(`account-${id}`, githubId, id, now, now);
  if (role !== "customer") {
    db.prepare("INSERT INTO people_roles (person_id, role, updated_at) VALUES (?, ?, ?)").run(
      id,
      role,
      now,
    );
  }
  const actor: Actor = { id, kind: "person", role, name };
  return actor;
}

/** A real site's database with its admin (named in the settings) and one more person. */
function realSite() {
  const { app, db } = buildTestApp();
  const config = loadConfig(REAL_SITE);
  const boss = addPerson(db, "person-boss", "Pat Boss", "1001", "admin");
  const people = createPeopleService(db, config);
  const connections = createConnectionService(db, () => true);
  return { app, db, config, boss, people, connections };
}

/** Files a ticket through the development entrance and makes this person its owner. */
async function ownedTicket(app: ReturnType<typeof buildTestApp>["app"], db: Db, ownerId: string) {
  const res = await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams on page two." });
  expect(res.status, res.text).toBe(201);
  const key = res.body.key as string;
  const id = Number(key.split("-")[1]);
  db.prepare("UPDATE tickets SET owner_id = ? WHERE id = ?").run(ownerId, id);
  return { id, key };
}

/** The error a call throws, so its status, code and words can be checked. */
function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Expected the call to be refused");
}

const ASSISTANT: Actor = {
  id: "connection-1",
  kind: "agent",
  role: "team",
  name: "Helper",
  scopes: ["read_tickets"],
};

describe("who may look at the People page", () => {
  it("tells a person their own role when they are refused", () => {
    const { people } = realSite();
    const error = refusal(() => people.page(teamActor));
    expect(error.status).toBe(403);
    expect(error.message).toContain("Only an admin");
    expect(error.message).toContain("You are a team member.");
  });

  it("refuses an assistant's connection without naming a role", () => {
    const { people } = realSite();
    const error = refusal(() => people.previewRoleChange(ASSISTANT, {}));
    expect(error.status).toBe(403);
    expect(error.message).not.toContain("You are");
  });
});

describe("the People page's rows", () => {
  it("locks the admin's own row and the rows the server settings name", () => {
    const { db, boss, people } = realSite();
    addPerson(db, "person-settings", "Sam Settings", "2002", "customer");
    addPerson(db, "person-free", "Fran Free", "3003", "customer");
    const rows = people.page(boss).people;
    const lockOf = (id: string) => rows.find((row) => row.id === id)?.locked;
    expect(lockOf("person-boss")).toBe("You");
    expect(lockOf("person-settings")).toBe("Team member, set in the server settings");
    expect(lockOf("person-free")).toBeNull();
  });

  it("says nothing about connections for someone whose role never changed", () => {
    const { db, boss, people } = realSite();
    addPerson(db, "person-free", "Fran Free", "3003", "customer");
    expect(people.page(boss, "person-free").changedLine).toBe("Fran Free is now a customer.");
  });

  it("counts more than one revoked connection in the plural", () => {
    const { db, boss, people, connections } = realSite();
    const other = addPerson(db, "person-other", "Olive Other", "3003", "admin");
    connections.create({ name: "First", scopes: ["read_tickets"] }, other);
    connections.create({ name: "Second", scopes: ["read_tickets"] }, other);
    people.changeRole(boss, { person: other.id, role: "team" });
    expect(people.page(boss, other.id).changedLine).toBe(
      "Olive Other is now a team member. Their 2 assistant connections were revoked.",
    );
  });
});

describe("what a role change would do", () => {
  it("names one connection to be revoked in the singular, and offers the button", () => {
    const { db, boss, people, connections } = realSite();
    const other = addPerson(db, "person-other", "Olive Other", "3003", "admin");
    connections.create({ name: "Only", scopes: ["read_tickets"] }, other);
    const preview = people.previewRoleChange(boss, { person: other.id, role: "team" });
    expect(preview.happens).toContain("Their 1 assistant connection will be revoked.");
    expect(preview.stop).toBeNull();
    expect(preview.button).toBe("Make Olive Other a team member");
    expect(preview.note).toBeNull();
  });

  it("counts more than one connection in the plural", () => {
    const { db, boss, people, connections } = realSite();
    const other = addPerson(db, "person-other", "Olive Other", "3003", "admin");
    connections.create({ name: "First", scopes: ["read_tickets"] }, other);
    connections.create({ name: "Second", scopes: ["read_tickets"] }, other);
    const preview = people.previewRoleChange(boss, { person: other.id, role: "customer" });
    expect(preview.happens).toContain("Their 2 assistant connections will be revoked.");
  });

  it("stops, with no button, when the role would not change", () => {
    const { db, boss, people } = realSite();
    addPerson(db, "person-free", "Fran Free", "3003", "team");
    const preview = people.previewRoleChange(boss, { person: "person-free", role: "team" });
    expect(preview.happens).toEqual([]);
    expect(preview.stop).toContain("already a team member");
    expect(preview.button).toBeNull();
  });

  it("names two archived tickets in the plural, and stops", async () => {
    const { app, db, boss, people } = realSite();
    const worker = addPerson(db, "person-worker", "Wes Worker", "3003", "team");
    const first = await ownedTicket(app, db, worker.id);
    const second = await ownedTicket(app, db, worker.id);
    db.prepare("UPDATE tickets SET archived_at = ? WHERE id IN (?, ?)").run(
      new Date().toISOString(),
      first.id,
      second.id,
    );
    const preview = people.previewRoleChange(boss, { person: worker.id, role: "customer" });
    const keys = `${first.key} and ${second.key}`;
    expect(preview.stop).toContain(`still owns ${keys}`);
    expect(preview.stop).toContain(`${keys} are archived`);
    expect(preview.button).toBeNull();
  });

  it("refuses a person the team settings name, pointing at that setting", () => {
    const { db, boss, people } = realSite();
    addPerson(db, "person-settings", "Sam Settings", "2002", "customer");
    const error = refusal(() =>
      people.previewRoleChange(boss, { person: "person-settings", role: "admin" }),
    );
    expect(error.status).toBe(403);
    expect(error.message).toContain("TEAM_GITHUB_IDS");
  });

  it("refuses someone who has never signed in here", () => {
    const { boss, people } = realSite();
    const error = refusal(() => people.previewRoleChange(boss, { person: "nobody", role: "team" }));
    expect(error.status).toBe(404);
  });

  it("on the development entrance, says the made-up people keep their roles", () => {
    const { db } = buildTestApp();
    const people = createPeopleService(db, loadConfig({ DEV_SIGN_IN: "on" }));
    const preview = people.previewRoleChange(adminActor, {
      person: customerOne.id,
      role: "team",
    });
    expect(preview.note).toContain("made up for development");
    expect(preview.button).toBeNull();
    expect(preview.happens).toHaveLength(1);
  });
});

describe("changing a role", () => {
  it("is refused on the development entrance", () => {
    const { db } = buildTestApp();
    const people = createPeopleService(db, loadConfig({ DEV_SIGN_IN: "on" }));
    const error = refusal(() =>
      people.changeRole(adminActor, { person: customerOne.id, role: "team" }),
    );
    expect(error.status).toBe(403);
    expect(error.message).toContain("keep their roles");
  });

  it("changes nothing and records nothing when the role is the same", () => {
    const { db, boss, people } = realSite();
    addPerson(db, "person-free", "Fran Free", "3003", "team");
    const result = people.changeRole(boss, { person: "person-free", role: "team" });
    expect(result).toEqual({ personId: "person-free", changed: false });
    expect(people.page(boss).changes).toEqual([]);
  });

  it("refuses with owns_tickets while the person owns an open ticket", async () => {
    const { app, db, boss, people } = realSite();
    const worker = addPerson(db, "person-worker", "Wes Worker", "3003", "team");
    await ownedTicket(app, db, worker.id);
    const error = refusal(() => people.changeRole(boss, { person: worker.id, role: "customer" }));
    expect(error.status).toBe(409);
    expect(error.code).toBe("owns_tickets");
    expect(people.page(boss).changes).toEqual([]);
  });

  it("refuses the admin's own row", () => {
    const { boss, people } = realSite();
    const error = refusal(() => people.changeRole(boss, { person: boss.id, role: "team" }));
    expect(error.status).toBe(403);
    expect(error.message).toContain("your own role");
  });
});

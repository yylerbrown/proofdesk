import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import request from "supertest";
import { buildTestApp, FROM_THIS_SITE, SIGN_IN_ENV } from "./helpers.js";

// Helpers for the People page tests: a server with GitHub sign-in, and browsers of people
// who have signed in. Nothing here talks to GitHub.

type TestDb = ReturnType<typeof buildTestApp>["db"];

/**
 * A server with GitHub sign-in and the development entrance closed. GitHub user 1001 is an
 * admin and 1002 a second admin, both named in the settings; 2002 is a team member named there.
 */
export function buildPeopleApp(env: NodeJS.ProcessEnv = {}) {
  return buildTestApp({
    ...SIGN_IN_ENV,
    DEV_SIGN_IN: "off",
    ADMIN_GITHUB_IDS: "1001,1002",
    TEAM_GITHUB_IDS: "2002",
    ...env,
  });
}

/**
 * Puts a person, their GitHub account and a session into the database, the way a finished
 * GitHub sign-in does, and returns their id and the Cookie header of their browser. It uses
 * the sign-in library's own test helpers on a second instance that shares the database and
 * the secret, so the cookie is one the app's own instance accepts.
 */
export async function signedInPerson(db: TestDb, githubId: string, name: string) {
  const testAuth = betterAuth({
    database: db,
    secret: SIGN_IN_ENV.BETTER_AUTH_SECRET,
    baseURL: SIGN_IN_ENV.BETTER_AUTH_URL,
    plugins: [testUtils()],
  });
  const test = (await testAuth.$context).test;
  const user = await test.saveUser(test.createUser({ name, email: `${githubId}@example.com` }));
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt")
     VALUES (?, ?, 'github', ?, ?, ?)`,
  ).run(`account-${githubId}`, githubId, user.id, now, now);
  const login = await test.login({ userId: user.id });
  return { id: user.id, cookie: login.headers.get("cookie") ?? "" };
}

/** Requests from this person's browser, on this site's own pages. */
export function browserOf(app: Parameters<typeof request.agent>[0], cookie: string) {
  return request.agent(app).set(FROM_THIS_SITE).set("Cookie", cookie);
}

/** The role the People page stores for a person, or null when none was chosen. */
export function storedRole(db: TestDb, personId: string): string | null {
  const row = db.prepare("SELECT role FROM people_roles WHERE person_id = ?").get(personId) as
    { role: string } | undefined;
  return row?.role ?? null;
}

/** How many lines the history of role changes holds. */
export function changeCount(db: TestDb): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM role_changes").get() as { n: number }).n;
}

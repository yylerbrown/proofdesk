import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Express } from "express";
import request from "supertest";
import { afterEach } from "vitest";
import { DEV_ACTORS, DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";

/** Made-up GitHub sign-in settings. Nothing in the tests talks to GitHub. */
export const SIGN_IN_ENV = {
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
  BETTER_AUTH_URL: "http://desk.test",
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
};

/** The same, as a production server needs them: its address must use https. */
export const PRODUCTION_SIGN_IN_ENV = { ...SIGN_IN_ENV, BETTER_AUTH_URL: "https://desk.test" };

const opened: { db: Db; dir: string }[] = [];

/** Builds an app on a fresh database file in a temp directory. Cleaned up after each test. */
export function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-test-"));
  const db = openDatabase(path.join(dir, "test.db"));
  opened.push({ db, dir });
  runMigrations(db);
  // Tests get in through the development entrance. Production refuses that entrance and
  // requires the GitHub sign-in settings instead, so a production test app gets those.
  const base = env.NODE_ENV === "production" ? PRODUCTION_SIGN_IN_ENV : { DEV_SIGN_IN: "on" };
  const config = loadConfig({ ...base, ...env });
  return { app: createApp(config, db), db, config };
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    if (db.open) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** One of the made-up people of the development entrance, by id. */
export function person(id: string): Actor {
  const found = DEV_ACTORS.find((actor) => actor.id === id);
  if (found === undefined) throw new Error(`No development person ${id}`);
  return found;
}

export const adminActor = person("dev-admin-1");
export const teamActor = person("dev-team-1");
export const customerOne = person("dev-customer-1");
export const customerTwo = person("dev-customer-2");

/** What a browser sends with a request made from one of this site's own pages. */
export const FROM_THIS_SITE = { "Sec-Fetch-Site": "same-origin" };

/** Requests to the app from a browser on this site with nobody signed in. */
export function visitor(app: Express) {
  return request.agent(app).set(FROM_THIS_SITE);
}

/** Requests to the app as this person, the way a signed-in browser sends them. */
export function as(app: Express, who: Actor) {
  return visitor(app).set("Cookie", `${DEV_COOKIE}=${who.id}`);
}

/** Most tests are about what the app does, not who may do it, so they act as the admin. */
export function admin(app: Express) {
  return as(app, adminActor);
}

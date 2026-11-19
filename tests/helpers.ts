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
  // requires the GitHub sign-in settings instead, so a production test app gets those. A
  // server with the GitHub settings refuses the entrance in every mode, so a test that gives
  // those settings gets no entrance.
  let base: NodeJS.ProcessEnv = { DEV_SIGN_IN: "on" };
  if (env.NODE_ENV === "production") base = PRODUCTION_SIGN_IN_ENV;
  else if (env.BETTER_AUTH_SECRET) base = {};
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

/**
 * The button of the header's person menu: the name of whoever is signed in, then their role as a
 * quiet word.
 */
export function signedInLine(name: string, role: "customer" | "team" | "admin"): string {
  const word = { customer: "Customer", team: "Team member", admin: "Admin" }[role];
  return `<summary><strong>${name}</strong> <small class="role-label">${word}</small></summary>`;
}

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

/**
 * Takes a ticket all the way to Resolved, by the only road there is: the team takes it,
 * moves it to In Progress, adds the change link and asks; the person who filed it says yes.
 */
export async function resolveTicket(app: Express, key: string, filedBy: Actor) {
  // The customer is asked against their own check, so a ticket filed without one gets one
  // from the customer first, as it would in use.
  const filed = (await admin(app).get(`/api/tickets/${key}`)).body;
  if (filed.fix_check === null) {
    await as(app, filedBy)
      .put(`/api/tickets/${key}`)
      .send({ title: filed.title, description: filed.description, fix_check: "It works now" });
  }
  await admin(app).post(`/api/tickets/${key}/take`);
  await admin(app).patch(`/api/tickets/${key}`).send({ status: "in_progress" });
  await admin(app)
    .put(`/api/tickets/${key}/change-link`)
    .send({ change_url: "https://example.com/change/1" });
  const ready = await admin(app)
    .post(`/api/tickets/${key}/ready`)
    .send({ try_url: "https://example.com/try", tried: "I printed ten pages.", result: "No jam." });
  const answered = await as(app, filedBy)
    .post(`/api/tickets/${key}/answer`)
    .send({ fixed: "yes", ready_token: ready.body.ready_token });
  if (answered.status !== 200) throw new Error(`Could not resolve ${key}: ${answered.text}`);
}

/**
 * Hands a ticket to the connection that holds this key, the way its owner would: if nobody
 * owns it, the admin takes it and starts work; if it is new, its owner starts work; then its
 * owner hands it to the connection. Agents see only tickets handed to them.
 */
export async function handToAgent(app: Express, ticketKey: string, agentKey: string) {
  const prefix = agentKey.slice("pd_".length, "pd_".length + 8);
  const page = (await admin(app).get("/connections")).text;
  const match = new RegExp(`href="/connections/(\\d+)"[^]*?pd_${prefix}`).exec(page);
  if (match === null) throw new Error(`No connection with key pd_${prefix}`);
  const connectionId = Number(match[1]);
  let ticket = (await admin(app).get(`/api/tickets/${ticketKey}`)).body;
  if (ticket.owner_id === null) {
    await admin(app).post(`/api/tickets/${ticketKey}/take-and-start`);
    ticket = (await admin(app).get(`/api/tickets/${ticketKey}`)).body;
  }
  const owner = as(app, person(ticket.owner_id));
  if (ticket.status === "new")
    await owner.patch(`/api/tickets/${ticketKey}`).send({ status: "in_progress" });
  const given = await owner
    .post(`/api/tickets/${ticketKey}/agent`)
    .send({ connection_id: connectionId });
  if (given.status !== 200) throw new Error(`Could not hand ${ticketKey}: ${given.text}`);
}

/**
 * Posts a page form as one browser and expects it refused the way the pages refuse a ticket
 * action: back to the ticket (303), with the reason shown at the top. Returns that reason.
 */
export async function refusedBackToTicket(
  browser: ReturnType<typeof visitor>,
  path: string,
  fields: Record<string, string> = {},
): Promise<string> {
  const res = await browser.post(path).type("form").send(fields);
  const key = /^\/tickets\/([^/]+)\//.exec(path)![1];
  if (res.status !== 303 || res.headers.location !== `/tickets/${key}`) {
    throw new Error(`Expected a trip back to ${key}, got ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const page = await browser.get(`/tickets/${key}`);
  const reason = /<p role="alert" class="refused">([^<]*)<\/p>/.exec(page.text)?.[1];
  if (reason === undefined) throw new Error("The ticket page shows no reason");
  return reason;
}

/**
 * Starts the app on a free port of 127.0.0.1, the address the tests' clients connect to, and
 * waits until it listens. Listening on every address instead can pick a port that another
 * program on the machine holds for 127.0.0.1, and a request would reach that program.
 */
export function listenLocally(app: Express): Promise<import("node:http").Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Closes test servers and every connection still open to them, and waits. A kept-alive
 * connection must not outlive its server, or a later request could reach a closed one.
 */
export function closeServers(servers: import("node:http").Server[]): Promise<void[]> {
  return Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  );
}

/**
 * The source files of the ticket service: every file in src/server/tickets except its
 * repository, which holds the SQL, and src/server/demo.ts, which keeps the demo's seeding
 * record for it. Paths are relative to the repository's root.
 */
export function ticketServiceFiles(): string[] {
  const folder = path.join("src", "server", "tickets");
  const files = fs
    .readdirSync(folder)
    .filter((file) => file.endsWith(".ts") && file !== "repository.ts")
    .map((file) => path.join(folder, file));
  return [...files, path.join("src", "server", "demo.ts")];
}

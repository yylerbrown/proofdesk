import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import type { Db } from "../src/server/db.js";
import { createDemoReset } from "../src/server/demo-reset.js";
import { createNotifier } from "../src/server/notify/notifier.js";
import { openSite } from "../src/server/start.js";
import { as as asPerson, buildTestApp, customerOne, FROM_THIS_SITE, teamActor } from "./helpers.js";
import { giveAddresses, ok } from "./notify-life.js";

// How the notifier is wired to the server: a run after every answered request that changed
// something, a timer as a safety net that stops with the server, and always the database the
// site serves now.

function count(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get() as { n: number }).n;
}

const folders: string[] = [];
const toClose: Db[] = [];

afterEach(() => {
  for (const db of toClose.splice(0)) if (db.open) db.close();
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe("after a request", () => {
  it("collects the notices of a request that changed something, once it is answered", async () => {
    const { app, db, config } = buildTestApp();
    giveAddresses(db);
    const notifier = createNotifier({ config, currentDb: () => db, log: () => undefined });
    const handler = notifier.afterChanges(app);
    const as = (who: { id: string }) =>
      request.agent(handler).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${who.id}`);

    expect(
      (await as(customerOne).post("/api/tickets").send({ title: "Jams", description: "x" })).status,
    ).toBe(201);
    expect((await as(teamActor).post("/api/tickets/SUP-1/take-and-start")).status).toBe(200);
    const reply = await as(teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "On it." });
    expect(reply.status).toBe(201);
    // The answer went out before the notice was written.
    await vi.waitFor(() => expect(count(db)).toBe(1));
  });

  it("does nothing after a request that only read", async () => {
    const { app, db, config } = buildTestApp();
    const collected: string[] = [];
    const notifier = createNotifier({
      config,
      currentDb: () => {
        collected.push("run");
        return db;
      },
      log: () => undefined,
    });
    const handler = notifier.afterChanges(app);
    await request(handler).get("/api/health");
    await request(handler).get("/tickets");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(collected).toEqual([]);
  });
});

describe("a mail server that stalls", () => {
  it("never holds back collecting: a change is written while a send is still on its way", async () => {
    const { app, db, config } = buildTestApp({
      SMTP_URL: "smtp://127.0.0.1:2525",
      MAIL_FROM: "notices@example.com",
    });
    giveAddresses(db);
    const release: (() => void)[] = [];
    const stalls = nodemailer.createTransport({
      name: "stalls",
      version: "1",
      send: (mail, done) => {
        release.push(() => done(null, { messageId: mail.data.messageId } as never));
      },
    }) as Transporter;
    const notifier = createNotifier({
      config,
      currentDb: () => db,
      log: () => undefined,
      transport: stalls,
    });
    await ok(
      asPerson(app, customerOne).post("/api/tickets").send({ title: "Jams", description: "x" }),
      201,
    );
    await ok(asPerson(app, teamActor).post("/api/tickets/SUP-1/take-and-start"));
    const reply = { kind: "reply", body: "On it." };
    await ok(asPerson(app, teamActor).post("/api/tickets/SUP-1/entries").send(reply), 201);
    const first = notifier.run();
    await vi.waitFor(() => expect(release.length).toBe(1));
    // The first mail is stuck on its way. A second change is collected at once all the same.
    await ok(asPerson(app, teamActor).post("/api/tickets/SUP-1/entries").send(reply), 201);
    void notifier.run();
    expect(count(db)).toBe(2);
    release.shift()!();
    await vi.waitFor(() => expect(release.length).toBe(1));
    release.shift()!();
    await first;
    const states = db.prepare("SELECT state FROM email_outbox ORDER BY id").all();
    expect(states).toEqual([{ state: "sent" }, { state: "sent" }]);
  });
});

describe("the timer", () => {
  it("runs on its own, and stops for good on a clean stop", async () => {
    const { db, config } = buildTestApp();
    let runs = 0;
    const notifier = createNotifier({
      config,
      currentDb: () => {
        runs += 1;
        return db;
      },
      log: () => undefined,
      everyMs: 5,
    });
    notifier.start();
    await vi.waitFor(() => expect(runs).toBeGreaterThan(2));
    notifier.stop();
    // A run already started may finish; after that nothing more starts.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = runs;
    notifier.soon();
    notifier.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(runs).toBe(after);
  });
});

describe("the demo resetting itself", () => {
  it("leaves the notifier working on the fresh database", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-notify-reset-"));
    folders.push(folder);
    const config = loadConfig({
      DEMO: "on",
      DEV_SIGN_IN: "off",
      DATABASE_PATH: `${folder}/app.db`,
    });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const clock = { now: Date.now() };
    const reset = createDemoReset({
      config,
      log,
      site: openSite(config, log),
      now: () => clock.now,
    });
    const notifier = createNotifier({ config, currentDb: () => reset.current().db, log });
    const first = reset.current().db;
    await notifier.run();
    const fromSamples = count(first);
    expect(fromSamples).toBeGreaterThan(0);

    clock.now += 25 * 60 * 60 * 1000;
    expect(reset.check()).toBe(true);
    toClose.push(reset.current().db);
    expect(first.open).toBe(false);
    // The fresh database has its own samples, collected again, and a visitor's change too.
    await notifier.run();
    expect(count(reset.current().db)).toBe(fromSamples);
    const customer = DEMO_ACTORS[0]!;
    const team = DEMO_ACTORS[1]!;
    const handler = notifier.afterChanges(reset.handler);
    const as = (who: { id: string }) =>
      request.agent(handler).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${who.id}`);
    const filed = await as(customer).post("/api/tickets").send({ title: "Jams", description: "x" });
    expect(filed.status).toBe(201);
    const key = filed.body.key as string;
    expect((await as(team).post(`/api/tickets/${key}/take-and-start`)).status).toBe(200);
    const reply = await as(team)
      .post(`/api/tickets/${key}/entries`)
      .send({ kind: "reply", body: "On it." });
    expect(reply.status).toBe(201);
    await vi.waitFor(() => expect(count(reset.current().db)).toBe(fromSamples + 1));
    expect(lines.filter((line) => /could not|error/i.test(line))).toEqual([]);
  });
});

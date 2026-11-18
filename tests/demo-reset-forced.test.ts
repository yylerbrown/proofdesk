import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import { createDemoReset, RESET_TIMES, type DemoReset } from "../src/server/demo-reset.js";
import { openSite } from "../src/server/start.js";
import { FROM_THIS_SITE } from "./helpers.js";

// The forced reset at two days happens whatever happens. A request that is held open and
// never finishes cannot put it off, and that request is told plainly to send again.

const MINUTE = 60 * 1000;
const customer = DEMO_ACTORS[0]!;
const folders: string[] = [];
const servers: http.Server[] = [];
const resets: DemoReset[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const reset of resets.splice(0)) {
    const { db } = reset.current();
    if (db.open) db.close();
  }
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A demo on a fresh database file, served on a local port, with a clock moved by hand. */
async function serveDemo() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-forced-"));
  folders.push(folder);
  const config = loadConfig({ DEMO: "on", DEV_SIGN_IN: "off", DATABASE_PATH: `${folder}/app.db` });
  const log = () => {};
  const clock = { now: Date.now() };
  const reset = createDemoReset({ config, log, site: openSite(config, log), now: () => clock.now });
  resets.push(reset);
  const server = http.createServer(reset.handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const asCustomer = () =>
    request.agent(reset.handler).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${customer.id}`);
  const titles = async () =>
    ((await asCustomer().get("/api/tickets")).body as { title: string }[]).map((t) => t.title);
  const setAside = () => fs.readdirSync(folder).filter((name) => name.includes(".before-reseed-"));
  return { reset, clock, port, asCustomer, titles, setAside };
}

type Answer = { status: number; retryAfter: string | undefined; body: string };

/**
 * Starts a request that declares a 1000-byte body and sends only its first byte, so it stays
 * open. Resolves with the answer, if one ever comes.
 */
async function holdOpen(port: number, title: string) {
  const held = http.request({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/api/tickets",
    headers: {
      ...FROM_THIS_SITE,
      Cookie: `${DEV_COOKIE}=${customer.id}`,
      "Content-Type": "application/json",
      "Content-Length": "1000",
    },
  });
  held.on("error", () => {});
  const answer = new Promise<Answer>((resolve) => {
    held.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        const retryAfter = res.headers["retry-after"];
        resolve({ status: res.statusCode ?? 0, retryAfter, body });
      });
    });
  });
  held.write("{");
  // Gives the server time to start answering it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const finish = () =>
    held.end(`"title":"${title}","description":"Sent slowly."}`.padEnd(999, " "));
  return { answer, finish };
}

describe("the demo's forced reset", () => {
  it("still waits for a request held open before the forced age", async () => {
    const demo = await serveDemo();
    demo.clock.now += RESET_TIMES.oldAfterMs + MINUTE;
    const held = await holdOpen(demo.port, "Held open");
    demo.clock.now += RESET_TIMES.quietForMs + MINUTE;
    expect(demo.reset.check()).toBe(false);
    expect(demo.setAside()).toEqual([]);
    held.finish();
    expect((await held.answer).status).toBe(201);
  });

  it("goes ahead past the forced age, and tells the held request to send again", async () => {
    const demo = await serveDemo();
    const samples = await demo.titles();
    await demo.asCustomer().post("/api/tickets").send({
      title: "A visitor's ticket",
      description: "Left by a visitor.",
    });
    const held = await holdOpen(demo.port, "Held open");

    demo.clock.now += RESET_TIMES.forcedAfterMs + MINUTE;
    expect(demo.reset.check()).toBe(true);
    expect(demo.setAside()).not.toEqual([]);

    const answer = await held.answer;
    expect(answer.status).toBe(503);
    expect(answer.retryAfter).toBe("10");
    expect(answer.body).toBe(
      "The demo is going back to its samples. Send this again in 10 seconds.\n",
    );
    // The rest of the held body arrives too late to reach either database.
    held.finish();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await demo.titles()).toEqual(samples);
    expect((await request(demo.reset.handler).get("/api/health")).status).toBe(200);
  });
});

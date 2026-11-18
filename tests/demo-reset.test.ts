import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { createDemoReset, KEEP_SET_ASIDE, RESET_TIMES } from "../src/server/demo-reset.js";
import { openSite } from "../src/server/start.js";
import { FROM_THIS_SITE } from "./helpers.js";

// The demo goes back to its samples by itself: once its samples are a day old and nobody has
// asked for anything for a while, or at two days whatever happens. The real site never does.

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const customer = DEMO_ACTORS[0]!;

const folders: string[] = [];
const resets: { current: () => { db: { open: boolean; close: () => void } } }[] = [];

afterEach(() => {
  for (const reset of resets.splice(0)) {
    const { db } = reset.current();
    if (db.open) db.close();
  }
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A demo on a database file in a fresh folder, with a clock the test moves by hand. */
function startDemo(options: { rename?: (from: string, to: string) => void } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-reset-"));
  folders.push(folder);
  const config = loadConfig({ DEMO: "on", DEV_SIGN_IN: "off", DATABASE_PATH: `${folder}/app.db` });
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const clock = { now: Date.now() };
  const reset = createDemoReset({
    config,
    log,
    site: openSite(config, log),
    now: () => clock.now,
    ...options,
  });
  resets.push(reset);
  const asCustomer = () =>
    request.agent(reset.handler).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${customer.id}`);
  const fileTicket = (title: string) =>
    asCustomer().post("/api/tickets").send({ title, description: "Left by a visitor." });
  const titles = async () =>
    ((await asCustomer().get("/api/tickets")).body as { title: string }[]).map((t) => t.title);
  const setAside = () => fs.readdirSync(folder).filter((name) => name.includes(".before-reseed-"));
  return { reset, clock, lines, folder, fileTicket, titles, setAside };
}

describe("the demo resetting itself", () => {
  it("does nothing before its samples are a day old", async () => {
    const demo = startDemo();
    expect((await demo.fileTicket("A visitor's ticket")).status).toBe(201);
    demo.clock.now += 23 * HOUR;
    expect(demo.reset.check()).toBe(false);
    expect(await demo.titles()).toContain("A visitor's ticket");
    expect(demo.setAside()).toEqual([]);
  });

  it("waits while someone is using it", async () => {
    const demo = startDemo();
    demo.clock.now += 25 * HOUR;
    // A request answered ten minutes ago: not quiet for long enough.
    await demo.fileTicket("A visitor's ticket");
    demo.clock.now += 10 * MINUTE;
    expect(demo.reset.check()).toBe(false);

    // A request still being answered: its body has not all arrived.
    demo.clock.now += 20 * MINUTE;
    const server = http.createServer(demo.reset.handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const open = http.request({
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
    open.on("error", () => {});
    open.write("{");
    await new Promise((resolve) => setTimeout(resolve, 100));
    demo.clock.now += 20 * MINUTE;
    expect(demo.reset.check()).toBe(false);
    open.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));

    expect(await demo.titles()).toContain("A visitor's ticket");
  });

  it("does not count the host's health checks as visitors", async () => {
    const demo = startDemo();
    demo.clock.now += 25 * HOUR;
    expect((await request(demo.reset.handler).get("/api/health")).status).toBe(200);
    expect(demo.reset.check()).toBe(true);
  });

  it("resets when old and quiet: samples back, the visitor's ticket gone, keys start again", async () => {
    const demo = startDemo();
    const before = await demo.titles();
    const filed = await demo.fileTicket("A visitor's ticket");
    const visitorsKey = filed.body.key as string;

    demo.clock.now += 25 * HOUR;
    const linesBefore = demo.lines.length;
    expect(demo.reset.check()).toBe(true);
    // One line in the log for the reset, and nothing else.
    expect(demo.lines.slice(linesBefore)).toEqual([
      expect.stringMatching(/^The demo reset to its samples\./),
    ]);

    expect(await demo.titles()).toEqual(before);
    const next = await demo.fileTicket("The next visitor's ticket");
    expect(next.body.key).toBe(visitorsKey);
    // The earlier database is on the disk, set aside, as the manual reset leaves it.
    expect(demo.setAside().some((name) => name.startsWith("app.db.before-reseed-"))).toBe(true);
    // The fresh samples are the new start: a day must pass again.
    demo.clock.now += 23 * HOUR;
    expect(demo.reset.check()).toBe(false);
  });

  it("resets at two days even if it is never quiet", async () => {
    const demo = startDemo();
    await demo.fileTicket("A visitor's ticket");
    demo.clock.now += 47 * HOUR;
    await demo.titles();
    expect(demo.reset.check()).toBe(false);
    demo.clock.now += 1 * HOUR + MINUTE;
    await demo.titles();
    expect(demo.reset.check()).toBe(true);
    expect(await demo.titles()).not.toContain("A visitor's ticket");
  });

  it(`keeps only the ${KEEP_SET_ASIDE} newest set-aside copies`, () => {
    const demo = startDemo();
    for (let day = 0; day < 5; day += 1) {
      demo.clock.now += 25 * HOUR;
      expect(demo.reset.check()).toBe(true);
    }
    const stamps = new Set(demo.setAside().map((name) => name.split(".before-reseed-")[1]));
    expect(stamps.size).toBe(KEEP_SET_ASIDE);
  });

  it("keeps serving the old data when the files cannot be moved, and tries again later", async () => {
    let failing = true;
    const demo = startDemo({
      rename: (from, to) => {
        if (failing) throw new Error("the disk refused");
        fs.renameSync(from, to);
      },
    });
    await demo.fileTicket("A visitor's ticket");
    demo.clock.now += 25 * HOUR;
    expect(demo.reset.check()).toBe(false);
    expect(demo.lines.join("\n")).toContain("The demo could not reset (the disk refused)");
    expect(await demo.titles()).toContain("A visitor's ticket");
    expect(demo.setAside()).toEqual([]);

    failing = false;
    demo.clock.now += RESET_TIMES.quietForMs;
    expect(demo.reset.check()).toBe(true);
    expect(await demo.titles()).not.toContain("A visitor's ticket");
  });

  it("puts the files back when a move fails halfway", async () => {
    let moves = 0;
    const demo = startDemo({
      rename: (from, to) => {
        moves += 1;
        if (moves === 2) throw new Error("the disk refused the second file");
        fs.renameSync(from, to);
      },
    });
    await demo.fileTicket("A visitor's ticket");
    // Another reader keeps the companion files on the disk, so there is more than one to move.
    const reader = openDatabase(path.join(demo.folder, "app.db"));
    try {
      demo.clock.now += 25 * HOUR;
      expect(demo.reset.check()).toBe(false);
      expect(moves).toBe(2);
      expect(await demo.titles()).toContain("A visitor's ticket");
      expect(demo.setAside()).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("puts the old files back when the fresh database cannot be opened", async () => {
    const demo = startDemo({
      rename: (from, to) => {
        fs.renameSync(from, to);
        // Something that is not a database appears in its place, so opening it fails.
        fs.writeFileSync(from, "not a database, and long enough to be read as a header ".repeat(4));
      },
    });
    await demo.fileTicket("A visitor's ticket");
    demo.clock.now += 25 * HOUR;
    expect(demo.reset.check()).toBe(false);
    expect(demo.lines.join("\n")).toContain("The demo could not reset");
    expect(await demo.titles()).toContain("A visitor's ticket");
    expect(demo.setAside()).toEqual([]);
  });

  it("offers a working demo connection straight after a reset", async () => {
    const demo = startDemo();
    demo.clock.now += 25 * HOUR;
    expect(demo.reset.check()).toBe(true);
    const res = await request(demo.reset.handler).post("/demo/connection").set(FROM_THIS_SITE);
    expect(res.status, res.text).toBe(200);
    // The key it shows reads the fresh sample made for assistants.
    const key = /class="key"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*class="key"/.exec(res.text);
    const token = key?.[1] ?? key?.[2];
    expect(token).toBeDefined();
    const sample = await request(demo.reset.handler)
      .get("/api/tickets/SUP-4")
      .set("Authorization", `Bearer ${token}`);
    expect(sample.status, sample.text).toBe(200);
  });

  it("resets as it starts when its samples are already old, and its timer stops", () => {
    const demo = startDemo();
    demo.clock.now += 25 * HOUR;
    demo.reset.start();
    demo.reset.stop();
    expect(demo.setAside()).toHaveLength(1);
  });

  it("is never built for the real site", () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-reset-"));
    folders.push(folder);
    const config = loadConfig({ DEV_SIGN_IN: "on", DATABASE_PATH: `${folder}/app.db` });
    const site = openSite(config, () => {});
    try {
      expect(() => createDemoReset({ config, log: () => {}, site })).toThrow(
        "Only the demo resets itself.",
      );
    } finally {
      site.db.close();
    }
  });
});

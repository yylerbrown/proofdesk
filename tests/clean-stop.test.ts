import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { DRAIN_MS, startServer } from "../src/server/serve.js";
import { buildTestApp } from "./helpers.js";

// On SIGTERM or SIGINT the server stops taking connections, lets requests in flight finish,
// closes the database and exits 0. After a deadline it exits anyway. A taken port exits 1.

/** A server whose one route answers only when the test says so. */
function slowServer(drainMs = 2000) {
  const { db } = buildTestApp();
  const lines: string[] = [];
  const exits: number[] = [];
  let answer: () => void = () => {};
  let arrivedNow: () => void = () => {};
  const arrived = new Promise<void>((resolve) => (arrivedNow = resolve));
  const handler: http.RequestListener = (_req, res) => {
    answer = () => res.end("finished");
    arrivedNow();
  };
  const running = startServer({
    handler,
    port: 0,
    closeDatabase: () => db.close(),
    log: (line) => lines.push(line),
    exit: (code) => exits.push(code),
    drainMs,
  });
  return { running, db, lines, exits, arrived, answer: () => answer() };
}

/**
 * Sends a GET on a kept-alive connection, as a browser does, and resolves with its body, or
 * with the error that ended it.
 */
function get(port: number): Promise<string> {
  const agent = new http.Agent({ keepAlive: true });
  return new Promise((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: "/slow", agent }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve(body));
        res.on("error", (error) => resolve(`error: ${error.message}`));
      })
      .on("error", (error) => resolve(`error: ${error.message}`));
  });
}

describe("a clean stop", () => {
  it("lets a request in flight finish, then closes the database and exits 0", async () => {
    const server = slowServer();
    const port = await server.running.listening;
    const reply = get(port);
    await server.arrived;

    const stopped = server.running.shutdown("SIGTERM");
    // A new connection is refused while the open request is still being answered.
    expect(await get(port)).toMatch(/^error: /);
    expect(server.db.open).toBe(true);
    expect(server.exits).toEqual([]);

    server.answer();
    const answered = Date.now();
    expect(await reply).toBe("finished");
    await stopped;
    expect(server.db.open).toBe(false);
    expect(server.exits).toEqual([0]);
    // The kept-alive connection closed once its answer was sent, well before the deadline.
    expect(Date.now() - answered).toBeLessThan(1000);
    expect(server.lines.join("\n")).not.toContain("still open");
  });

  it("closes a request still open at the deadline and exits anyway", async () => {
    const server = slowServer(100);
    const port = await server.running.listening;
    const reply = get(port);
    await server.arrived;

    const started = Date.now();
    await server.running.shutdown("SIGTERM");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await reply).toMatch(/^error: |^$/);
    expect(server.db.open).toBe(false);
    expect(server.exits).toEqual([0]);
    expect(server.lines.join("\n")).toContain("still open after 100 ms");
  });

  it("does the same once when a second signal arrives", async () => {
    const server = slowServer();
    const port = await server.running.listening;
    const reply = get(port);
    await server.arrived;

    const first = server.running.shutdown("SIGTERM");
    const second = server.running.shutdown("SIGINT");
    expect(second).toBe(first);
    server.answer();
    await reply;
    await first;
    expect(server.exits).toEqual([0]);
    expect(server.lines.filter((line) => line.startsWith("Stopping"))).toHaveLength(1);
  });
});

describe("a port already in use", () => {
  it("prints one plain line and exits 1", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, resolve));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const { db } = buildTestApp();
      const lines: string[] = [];
      let exited: (code: number) => void = () => {};
      const exitCode = new Promise<number>((resolve) => (exited = resolve));
      startServer({
        handler: (_req, res) => res.end(),
        port,
        closeDatabase: () => db.close(),
        log: (line) => lines.push(line),
        exit: (code) => exited(code),
      });
      expect(await exitCode).toBe(1);
      expect(lines).toEqual([`Port ${port} is already in use, so the server did not start.`]);
      expect(db.open).toBe(false);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });
});

describe("the host's stop", () => {
  for (const file of ["fly.toml", "fly.proofdesk.toml"]) {
    it(`${file} sends SIGTERM and waits longer than the server takes to stop`, () => {
      const text = fs.readFileSync(file, "utf8");
      expect(/^kill_signal = "SIGTERM"$/m.test(text)).toBe(true);
      const seconds = Number(/^kill_timeout = (\d+)$/m.exec(text)?.[1]);
      expect(seconds * 1000).toBeGreaterThan(DRAIN_MS);
    });
  }
});

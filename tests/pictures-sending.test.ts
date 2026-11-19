import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { HttpError } from "../src/server/errors.js";
import {
  SEND_REFUSALS,
  SEND_RETRY_SECONDS,
  SENDS_AT_ONCE,
  sendPicturesFewAtOnce,
} from "../src/server/pictures/sending.js";
import { buildTestApp, FROM_THIS_SITE } from "./helpers.js";

// Sending pictures. Each picture is held in memory until its answer is sent, so the server sends
// only a few at once, answers 503 above that, and cuts off an answer nobody reads.

const servers: http.Server[] = [];
const sockets: net.Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

async function listen(app: express.Express): Promise<number> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

/** A small app that sends a large answer, behind the count given. */
function sendingApp(options: { atOnce?: number; deadlineMs?: number }, started: () => void) {
  // Larger than a connection buffers, so an answer nobody reads stays unsent.
  const large = Buffer.alloc(16 * 1024 * 1024, 7);
  const app = express();
  app.get("/picture", sendPicturesFewAtOnce(options), (_req, res) => {
    started();
    res.type("image/png").send(large);
  });
  const answerError: express.ErrorRequestHandler = (err: HttpError, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(err.status).json({ error: err.message });
  };
  app.use(answerError);
  return app;
}

/** Asks for a path and never reads the answer. */
function askAndNeverRead(port: number, path: string, cookie = ""): void {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  socket.on("error", () => {});
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nSec-Fetch-Site: same-origin\r\n` +
      (cookie === "" ? "" : `Cookie: ${cookie}\r\n`) +
      "\r\n",
  );
  socket.pause();
}

/** Asks for a path and reads the whole answer. */
function ask(port: number, path: string, cookie = "") {
  return new Promise<{ status: number; retryAfter: string | undefined; text: string }>(
    (done, fail) => {
      const headers: Record<string, string> = { ...FROM_THIS_SITE };
      if (cookie !== "") headers.Cookie = cookie;
      const sent = http.get({ port, host: "127.0.0.1", path, headers, agent: false }, (answer) => {
        const chunks: Buffer[] = [];
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () =>
          done({
            status: answer.statusCode ?? 0,
            retryAfter: answer.headers["retry-after"],
            text: Buffer.concat(chunks).toString("latin1"),
          }),
        );
      });
      sent.on("error", fail);
    },
  );
}

/** Resolves once the count of calls reaches n. */
function counter() {
  let count = 0;
  const waiting: { n: number; done: () => void }[] = [];
  return {
    hit: () => {
      count += 1;
      for (const wait of waiting) if (count >= wait.n) wait.done();
    },
    reached: (n: number) =>
      count >= n ? Promise.resolve() : new Promise<void>((done) => waiting.push({ n, done })),
  };
}

describe("how many pictures the server sends at once", () => {
  it("sends eight at once and answers a ninth 503 with a retry hint", async () => {
    const started = counter();
    const port = await listen(sendingApp({}, started.hit));
    for (let i = 0; i < SENDS_AT_ONCE; i += 1) askAndNeverRead(port, "/picture");
    await started.reached(SENDS_AT_ONCE);

    const ninth = await ask(port, "/picture");
    expect(ninth.status).toBe(503);
    expect(ninth.retryAfter).toBe(String(SEND_RETRY_SECONDS));
    expect(JSON.parse(ninth.text)).toEqual({ error: SEND_REFUSALS.busy });
  });

  it("cuts off an answer nobody reads at its deadline, and frees its place", async () => {
    const started = counter();
    const port = await listen(sendingApp({ atOnce: 1, deadlineMs: 100 }, started.hit));
    askAndNeverRead(port, "/picture");
    await started.reached(1);
    expect((await ask(port, "/picture")).status).toBe(503);

    // The held answer is never read: only the deadline ends it and frees its place.
    let next = await ask(port, "/picture");
    for (let tries = 0; next.status === 503 && tries < 50; tries += 1) {
      await new Promise((done) => setTimeout(done, 20));
      next = await ask(port, "/picture");
    }
    expect(next.status).toBe(200);
    expect(next.text.length).toBe(16 * 1024 * 1024);
  });
});

describe("the picture address", () => {
  it("is behind the count", () => {
    const { app } = buildTestApp();
    // Express keeps each route's handlers in order. The count must come before the handler.
    type Layer = {
      route?: { path: string; stack: { name: string }[] };
      handle?: { stack?: Layer[] };
    };
    const layers = (stack: Layer[]): Layer[] =>
      stack.flatMap((layer) => [layer, ...layers(layer.handle?.stack ?? [])]);
    const router = (app as unknown as { router: { stack: Layer[] } }).router;
    const route = layers(router.stack).find(
      (layer) => layer.route?.path === "/tickets/:key/pictures/:id",
    )?.route;
    expect(route?.stack.map((handler) => handler.name)).toEqual([
      "countPictureSends",
      "<anonymous>",
    ]);
  });
});

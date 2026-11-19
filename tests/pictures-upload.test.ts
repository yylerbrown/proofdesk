import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { DEMO_BUDGET, seedDemo } from "../src/server/demo.js";
import { PICTURE_REFUSALS, type PictureLimits } from "../src/server/pictures/limits.js";
import { samplePicture } from "../src/server/pictures/sample.js";
import { readPictures, UPLOAD_REFUSALS } from "../src/server/pictures/upload.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, visitor } from "./helpers.js";

// Reading the pictures a form sends. Pictures are held in memory while they are read, so the
// parser cuts a picture off at the size limit, stops at the count, reads nothing for someone who
// may add nothing, and reads only a few uploads at a time across the server.

const PNG = samplePicture();
const SMALL: PictureLimits = {
  maxBytes: PNG.length + 10,
  perMessage: 2,
  perTicket: 20,
  personTotalBytes: 1024 * 1024,
  siteTotalBytes: 1024 * 1024,
};
/** A picture larger than an ordinary form, so its form counts towards the uploads at once. */
const LARGE = Buffer.concat([PNG, Buffer.alloc(200 * 1024)]);
const [demoCustomer, , demoAdmin] = DEMO_ACTORS as [Actor, Actor, Actor];

/**
 * A small app around readPictures alone. Each request is made by the actor given, and answers
 * with what the parser left in res.locals.pictures. arrived is called as each request reaches
 * the parser.
 */
function parserApp(
  limits: PictureLimits,
  options: {
    actor?: Actor | null;
    atOnce?: number;
    deadlineMs?: number;
    arrived?: () => void;
  } = {},
): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = options.actor === undefined ? customerOne : options.actor;
    options.arrived?.();
    next();
  });
  app.post("/form", readPictures(limits, options.atOnce, options.deadlineMs), (_req, res) => {
    const read = res.locals.pictures as { files: Buffer[]; refused: string | null } | undefined;
    res.json(
      read === undefined
        ? { read: false }
        : { read: true, files: read.files.map((file) => file.length), refused: read.refused },
    );
  });
  const answerError: express.ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const { status, message } = err as { status?: number; message: string };
    res.status(status ?? 500).json({ error: message });
  };
  app.use(answerError);
  return app;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});

async function listen(app: Express): Promise<number> {
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

describe("the picture parser's own limits", () => {
  it("cuts off a picture over the size limit instead of reading it whole", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(1024)]);
    const answer = await request(parserApp(SMALL)).post("/form").attach("pictures", big, "big.png");
    expect(answer.body).toEqual({
      read: true,
      files: [],
      refused: PICTURE_REFUSALS.tooLarge(SMALL),
    });
  });

  it("stops at the most pictures one form may send", async () => {
    let post = request(parserApp(SMALL)).post("/form");
    for (const name of ["a.png", "b.png", "c.png"]) post = post.attach("pictures", PNG, name);
    const answer = await post;
    expect(answer.body).toEqual({
      read: true,
      files: [],
      refused: PICTURE_REFUSALS.tooManyInMessage(SMALL),
    });
  });

  it("reads pictures within the limits", async () => {
    const answer = await request(parserApp(SMALL))
      .post("/form")
      .attach("pictures", PNG, "a.png")
      .attach("pictures", PNG, "b.png");
    expect(answer.body).toEqual({ read: true, files: [PNG.length, PNG.length], refused: null });
  });
});

describe("pictures from someone who may add nothing", () => {
  it("are never read when nobody is signed in", async () => {
    const answer = await request(parserApp(SMALL, { actor: null }))
      .post("/form")
      .attach("pictures", PNG, "a.png");
    expect(answer.body).toEqual({ read: false });
  });

  it("are never read for the read-only preview", async () => {
    const answer = await request(parserApp(SMALL, { actor: demoAdmin }))
      .post("/form")
      .attach("pictures", PNG, "a.png");
    expect(answer.body).toEqual({ read: false });
  });

  it("leave a signed-out visitor sent to sign in, as before", async () => {
    const { app, db } = buildTestApp();
    const answer = await visitor(app)
      .post("/tickets")
      .field("title", "Printer jams")
      .field("description", "On page two")
      .attach("pictures", PNG, "a.png");
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/sign-in");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("leave the read-only preview refused, with no picture cookie", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix, DEMO_BUDGET);
    seedDemo(service);
    const before = built.db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get();
    const answer = await request(built.app)
      .post("/tickets/SUP-1/entries")
      .set(FROM_THIS_SITE)
      .set("Cookie", `${DEV_COOKIE}=${demoAdmin.id}`)
      .field("kind", "note")
      .field("body", "A note")
      .attach("pictures", PNG, "a.png");
    expect(answer.status).toBe(303);
    expect(answer.headers.location).toBe("/tickets/SUP-1");
    expect(String(answer.headers["set-cookie"])).not.toContain("demo_pictures=");
    expect(built.db.prepare("SELECT COUNT(*) AS n FROM ticket_pictures").get()).toEqual(before);
  });
});

/** Starts a large upload that never finishes arriving. */
function holdUpload(address: string): http.ClientRequest {
  const held = http.request(`${address}/form`, {
    method: "POST",
    headers: {
      "Content-Type": "multipart/form-data; boundary=held",
      "Content-Length": "1000000",
    },
  });
  held.on("error", () => {});
  held.write('--held\r\nContent-Disposition: form-data; name="pictures"; filename="a.png"\r\n\r\n');
  return held;
}

/** Sends a large upload, retrying for a while if the server is busy, and gives its status. */
async function largeUploadStatus(address: string, tries = 1): Promise<number> {
  let status = 0;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 20));
    status = (await request(address).post("/form").attach("pictures", LARGE, "big.png")).status;
    if (status !== 503) break;
  }
  return status;
}

describe("how many uploads the server reads at once", () => {
  /** A server that reads one large upload at once, and resolves firstArrived as one arrives. */
  async function oneAtOnce(deadlineMs?: number) {
    let arrivedFirst = () => {};
    const firstArrived = new Promise<void>((done) => (arrivedFirst = done));
    const port = await listen(
      parserApp(SMALL, { atOnce: 1, deadlineMs, arrived: () => arrivedFirst() }),
    );
    return { address: `http://127.0.0.1:${port}`, firstArrived };
  }

  it("refuses one more than it reads at once, and frees a place when one ends", async () => {
    const { address, firstArrived } = await oneAtOnce();
    const held = holdUpload(address);
    await firstArrived;

    const refused = await request(address).post("/form").attach("pictures", LARGE, "b.png");
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: UPLOAD_REFUSALS.busy });

    // The first one's connection closes, and its place is free again.
    held.destroy();
    expect(await largeUploadStatus(address, 50)).toBe(200);
    // A finished upload frees its place too.
    expect(await largeUploadStatus(address)).toBe(200);
  });

  it("still reads a form no larger than an ordinary one while every place is taken", async () => {
    const { address, firstArrived } = await oneAtOnce();
    const held = holdUpload(address);
    await firstArrived;
    expect(await largeUploadStatus(address)).toBe(503);

    const textOnly = await request(address).post("/form").field("body", "Here is what I see.");
    expect(textOnly.status).toBe(200);
    expect(textOnly.body).toEqual({ read: true, files: [], refused: null });
    held.destroy();
  });

  it("cuts off an upload still arriving at its deadline, and frees its place", async () => {
    const { address, firstArrived } = await oneAtOnce(100);
    const held = holdUpload(address);
    const cutOff = new Promise<void>((done) => held.on("close", () => done()));
    await firstArrived;
    expect(await largeUploadStatus(address)).toBe(503);

    // The held upload never stops on its own: only the deadline ends it.
    await cutOff;
    expect(await largeUploadStatus(address, 50)).toBe(200);
  });
});

describe("a form the parser cannot read", () => {
  it("is answered 400 with one sentence, and nothing is logged", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = buildTestApp();
    const noBoundary = await as(app, customerOne)
      .post("/tickets")
      .set("Content-Type", "multipart/form-data")
      .send("title=Printer");
    expect(noBoundary.status).toBe(400);
    expect(noBoundary.text).toContain(UPLOAD_REFUSALS.unreadable);
    const cutShort = await as(app, customerOne)
      .post("/tickets")
      .set("Content-Type", "multipart/form-data; boundary=cut")
      .send('--cut\r\nContent-Disposition: form-data; name="title"\r\n\r\nPrinter');
    expect(cutShort.status).toBe(400);
    expect(cutShort.text).toContain(UPLOAD_REFUSALS.unreadable);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("names a file sent in a box that is not for pictures", async () => {
    const { app } = buildTestApp();
    const answer = await as(app, customerOne)
      .post("/tickets")
      .field("title", "Printer jams")
      .field("description", "On page two")
      .attach("attachment", PNG, "a.png");
    expect(answer.status).toBe(400);
    expect(answer.text).toContain(UPLOAD_REFUSALS.notAPictureField);
  });
});

describe("the demo's picture cookie", () => {
  it("is sent over https only in production, and only once the picture is saved", async () => {
    const built = buildTestApp({
      NODE_ENV: "production",
      DEMO: "on",
      BETTER_AUTH_SECRET: "",
      BETTER_AUTH_URL: "",
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    });
    const asCustomer = () =>
      request(built.app)
        .post("/tickets")
        .set(FROM_THIS_SITE)
        .set("Cookie", `${DEV_COOKIE}=${demoCustomer.id}`);
    // A refused picture saves nothing and gives no cookie.
    const refused = await asCustomer()
      .field("title", "Printer jams")
      .field("description", "On page two")
      .attach("pictures", Buffer.from("not a picture"), "a.png");
    expect(refused.status).toBe(400);
    expect(String(refused.headers["set-cookie"])).not.toContain("demo_pictures=");
    const saved = await asCustomer()
      .field("title", "Printer jams")
      .field("description", "On page two")
      .attach("pictures", PNG, "a.png");
    expect(saved.status).toBe(303);
    expect(String(saved.headers["set-cookie"])).toMatch(/demo_pictures=[^;]+;.*Secure/);
  });
});

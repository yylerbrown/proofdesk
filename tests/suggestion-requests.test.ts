import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { LISTEN_TEXT, SUGGEST_CHECKS_TEXT } from "../src/server/api/describe.js";
import { loadConfig } from "../src/server/config.js";
import { DEFAULT_SCOPES } from "../src/server/connections/service.js";
import { createDemoReset } from "../src/server/demo-reset.js";
import { openSite } from "../src/server/start.js";
import { MOST_HELD_CALLS } from "../src/server/suggestions/listening.js";
import { MOST_REQUESTS_PER_PERSON } from "../src/server/suggestions/requests.js";
import { keyOnPage } from "./key-on-page.js";
import {
  admin,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  customerTwo,
  listenLocally,
  teamActor,
  visitor,
} from "./helpers.js";

// A person asks a listening assistant for ways to verify their new ticket, and the assistant
// answers within seconds. How much an assistant is asked is one setting per connection: Off,
// When asked (only when a person presses) or Automatic (also when a page asks by itself).

const noCheck = { title: "Export is empty", description: "The monthly export has no rows." };

const servers: Server[] = [];
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

type Setting = "off" | "when_asked" | "automatic";

async function issue(app: Express, suggestions: Setting, name = "Helper") {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name, scopes: DEFAULT_SCOPES, suggestions });
  return keyOnPage(res.text);
}

/** What an assistant sends with its key. */
function agent(app: Express, key: string) {
  return {
    /** Starts a wait_for_requests call at once and gives its answer when it comes. */
    wait: (seconds: number) =>
      request(app)
        .get(`/api/suggestion-requests?wait_seconds=${seconds}`)
        .set("Authorization", `Bearer ${key}`)
        .then((res) => res),
    answer: (id: number, options: string[]) =>
      request(app)
        .post("/api/suggestion-requests/answer")
        .set("Authorization", `Bearer ${key}`)
        .send({ id, options }),
    get: (url: string) => request(app).get(url).set("Authorization", `Bearer ${key}`),
  };
}

/** What the customer's page reads beside the suggestions. */
async function state(app: Express, ticketKey = "SUP-1", who = customerOne) {
  return (await as(app, who).get(`/tickets/${ticketKey}/check-suggestions`)).body as {
    check_suggestions: { words: string }[];
    available: { listening: boolean; automatic: boolean };
    request: string;
  };
}

/** The customer's page asks: by a press, or by itself with pressed=false. */
function ask(app: Express, ticketKey = "SUP-1", pressed = true, who = customerOne) {
  return as(app, who)
    .post(`/tickets/${ticketKey}/check-suggestions/request`)
    .accept("json")
    .type("form")
    .send({ pressed: String(pressed) });
}

/** Waits until the page says an assistant is listening, so a held call has started. */
async function untilListening(app: Express, ticketKey = "SUP-1") {
  for (let tries = 0; tries < 200; tries += 1) {
    if ((await state(app, ticketKey)).available.listening) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No assistant started listening.");
}

async function fileNoCheck(app: Express) {
  const res = await as(app, customerOne).post("/api/tickets").send(noCheck);
  return res.body.key as string;
}

function countRequests(db: { prepare: (sql: string) => { get: () => unknown } }): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM suggestion_requests").get() as { n: number }).n;
}

describe("the three settings", () => {
  async function connect(app: Express, key: string) {
    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  async function offered(app: Express, key: string) {
    const client = await connect(app, key);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const llms = (await agent(app, key).get("/llms.txt")).text;
    const guide = (await agent(app, key).get("/api")).body;
    return { tools, text: client.getInstructions() ?? "", llms, guide };
  }

  it("Off offers no tool to listen, answer or suggest, and says nothing of them", async () => {
    const { app } = buildTestApp();
    const seen = await offered(app, await issue(app, "off"));
    for (const tool of ["wait_for_requests", "answer_request", "suggest_checks"]) {
      expect(seen.tools).not.toContain(tool);
    }
    for (const text of [seen.text, seen.llms]) {
      expect(text).not.toContain(LISTEN_TEXT);
      expect(text).not.toContain(SUGGEST_CHECKS_TEXT);
    }
    expect(seen.guide.wait_for_requests).toBeUndefined();
  });

  it("When asked offers listening and answering, and no wider read", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const key = await issue(app, "when_asked");
    const seen = await offered(app, key);
    expect(seen.tools).toEqual(expect.arrayContaining(["wait_for_requests", "answer_request"]));
    expect(seen.tools).not.toContain("suggest_checks");
    expect(seen.text).toContain(LISTEN_TEXT);
    expect(seen.text).not.toContain(SUGGEST_CHECKS_TEXT);
    expect(seen.llms).toContain(LISTEN_TEXT);
    expect(seen.guide.wait_for_requests).toBe(LISTEN_TEXT);
    // New tickets with no check are not listed or read unasked.
    expect((await agent(app, key).get("/api/tickets")).body).toEqual([]);
    expect((await agent(app, key).get("/api/tickets/SUP-1")).status).toBe(404);
  });

  it("Automatic offers all three, both paragraphs, and the wider read", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const key = await issue(app, "automatic");
    const seen = await offered(app, key);
    expect(seen.tools).toEqual(
      expect.arrayContaining(["wait_for_requests", "answer_request", "suggest_checks"]),
    );
    expect(seen.text).toContain(LISTEN_TEXT);
    expect(seen.text).toContain(SUGGEST_CHECKS_TEXT);
    const listed = (await agent(app, key).get("/api/tickets")).body as { key: string }[];
    expect(listed.map((row) => row.key)).toEqual(["SUP-1"]);
  });

  it("listening works over MCP too", async () => {
    const { app } = buildTestApp();
    const client = await connect(app, await issue(app, "when_asked"));
    const result = await client.callTool({
      name: "wait_for_requests",
      arguments: { wait_seconds: 1 },
    });
    const content = result.content as { text: string }[];
    expect(JSON.parse(content[0]!.text).result).toEqual({ requests: [] });
  });

  it("refuses an Off connection and a demo connection that tries to listen", async () => {
    const { app } = buildTestApp();
    const off = await issue(app, "off");
    expect((await agent(app, off).wait(1)).status).toBe(403);
    expect((await agent(app, off).answer(1, ["I see every row"])).status).toBe(403);

    const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const { createTicketService } = await import("../src/server/tickets/service.js");
    const { seedDemo } = await import("../src/server/demo.js");
    seedDemo(createTicketService(demo.db, demo.config.ticketPrefix));
    const demoKey = keyOnPage((await visitor(demo.app).post("/demo/connection")).text);
    expect((await agent(demo.app, demoKey).wait(1)).status).toBe(403);
  });
});

describe("a request and a waiting assistant", () => {
  it("reaches a waiting call within a second, and the answer reaches the page", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const helper = agent(app, await issue(app, "when_asked"));
    const waiting = helper.wait(10);
    await untilListening(app);
    const asked = Date.now();
    const res = await ask(app);
    expect(res.status, res.text).toBe(201);
    expect(res.body).toEqual({ request: "waiting" });
    const handed = await waiting;
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(handed.body).toEqual({
      requests: [
        {
          id: expect.any(Number),
          key: "SUP-1",
          title: noCheck.title,
          description: noCheck.description,
        },
      ],
    });
    const answered = await helper.answer(handed.body.requests[0].id, [
      "I export this month and every row is there",
    ]);
    expect(answered.status, answered.text).toBe(201);
    const read = await state(app);
    expect(read.request).toBe("answered");
    expect(read.check_suggestions.map((s) => s.words)).toEqual([
      "I export this month and every row is there",
    ]);
  });

  it("answers an idle wait with an empty list at its deadline", async () => {
    const { app } = buildTestApp();
    const helper = agent(app, await issue(app, "when_asked"));
    const started = Date.now();
    const res = await helper.wait(1);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("hands a request to each connection once, and the first answer wins", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const first = agent(app, await issue(app, "when_asked", "First"));
    const second = agent(app, await issue(app, "automatic", "Second"));
    const waits = [first.wait(10), second.wait(10)];
    await untilListening(app);
    await ask(app);
    const [one, two] = await Promise.all(waits);
    const id = one!.body.requests[0].id as number;
    expect(two!.body.requests[0].id).toBe(id);
    expect((await first.answer(id, ["Every row is there"])).status).toBe(201);
    const late = await second.answer(id, ["The file opens"]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("request_closed");
    expect(late.body.error.message).toBe(`Request ${id} was already answered.`);
    expect((await state(app)).check_suggestions.map((s) => s.words)).toEqual([
      "Every row is there",
    ]);
    // Neither is handed the same request again.
    expect((await first.wait(1)).body).toEqual({ requests: [] });
  });

  it("keeps one open request per ticket, and a press makes a page's own request a pressed one", async () => {
    const { app, db } = buildTestApp();
    await fileNoCheck(app);
    await agent(app, await issue(app, "automatic")).wait(1);
    expect((await ask(app, "SUP-1", false)).status).toBe(201);
    expect((await ask(app, "SUP-1", true)).status).toBe(201);
    expect((await ask(app, "SUP-1", true)).status).toBe(201);
    expect(countRequests(db)).toBe(1);
    const row = db.prepare("SELECT pressed FROM suggestion_requests").get() as { pressed: number };
    expect(row.pressed).toBe(1);
  });
});

describe("expiry and removal", () => {
  it("expires an unanswered request after a minute, and removes it after ten", async () => {
    const { app, db } = buildTestApp();
    await fileNoCheck(app);
    const helper = agent(app, await issue(app, "when_asked"));
    await helper.wait(1);
    await ask(app);
    const id = (db.prepare("SELECT id FROM suggestion_requests").get() as { id: number }).id;
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    db.prepare("UPDATE suggestion_requests SET created_at = ?").run(ago(61));
    expect((await state(app)).request).toBe("expired");
    expect((await helper.wait(1)).body).toEqual({ requests: [] });
    const late = await helper.answer(id, ["Every row is there"]);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("request_closed");
    db.prepare("UPDATE suggestion_requests SET created_at = ?").run(ago(601));
    expect((await state(app)).request).toBe("none");
    expect(countRequests(db)).toBe(0);
  });

  it("removes requests with their ticket", async () => {
    const { app, db } = buildTestApp();
    await fileNoCheck(app);
    await agent(app, await issue(app, "when_asked")).wait(1);
    await ask(app);
    expect(countRequests(db)).toBe(1);
    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(countRequests(db)).toBe(0);
  });

  it("are cleared by the demo reset", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-requests-"));
    folders.push(folder);
    const config = loadConfig({
      DEMO: "on",
      DEV_SIGN_IN: "off",
      DATABASE_PATH: `${folder}/app.db`,
    });
    const clock = { now: Date.now() };
    const reset = createDemoReset({
      config,
      log: () => {},
      site: openSite(config, () => {}),
      now: () => clock.now,
    });
    const before = reset.current().db;
    // No demo connection may listen, so the row is written straight into the database.
    before
      .prepare(
        `INSERT INTO suggestion_requests (ticket_id, requested_by, pressed, created_at)
         VALUES (1, 'demo-customer', 1, ?)`,
      )
      .run(new Date().toISOString());
    expect(countRequests(before)).toBe(1);
    clock.now += 25 * 60 * 60 * 1000;
    expect(reset.check()).toBe(true);
    const after = reset.current().db;
    expect(countRequests(after)).toBe(0);
    after.close();
  });
});

describe("the limits", () => {
  it(`allows ${MOST_REQUESTS_PER_PERSON} requests per person in ten minutes`, async () => {
    const { app, db } = buildTestApp();
    const helper = agent(app, await issue(app, "when_asked"));
    for (let n = 0; n <= MOST_REQUESTS_PER_PERSON; n += 1) await fileNoCheck(app);
    await helper.wait(1);
    for (let n = 1; n <= MOST_REQUESTS_PER_PERSON; n += 1) {
      expect((await ask(app, `SUP-${n}`)).status).toBe(201);
    }
    const over = await ask(app, `SUP-${MOST_REQUESTS_PER_PERSON + 1}`);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("too_many_requests");
    expect(countRequests(db)).toBe(MOST_REQUESTS_PER_PERSON);
  });

  it(`holds ${MOST_HELD_CALLS} calls at once in all, one per connection`, async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const helpers = [];
    for (let n = 0; n <= MOST_HELD_CALLS; n += 1) {
      helpers.push(agent(app, await issue(app, "when_asked", `Helper ${n}`)));
    }
    const held = helpers.slice(0, MOST_HELD_CALLS).map((helper) => helper.wait(3));
    await untilListening(app);
    // Every held call has started once the fifth is refused, so try until it is.
    let fifth = await helpers[MOST_HELD_CALLS]!.wait(1);
    for (let tries = 0; tries < 100 && fifth.status === 200; tries += 1) {
      fifth = await helpers[MOST_HELD_CALLS]!.wait(1);
    }
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe("too_many_requests");
    expect(fifth.body.error.retry).toBe(true);
    // A second call from the same connection ends its first, which answers empty at once.
    const started = Date.now();
    const again = helpers[0]!.wait(3);
    const ended = await held[0]!;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ended.body).toEqual({ requests: [] });
    await Promise.all([again, ...held.slice(1)]);
  });
});

describe("listening", () => {
  it("counts a connection with a call open or made in the last 40 seconds", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    expect((await state(app)).available).toEqual({ listening: false, automatic: false });
    const refused = await ask(app);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("no_assistant_listening");
    const helper = agent(app, await issue(app, "when_asked"));
    await helper.wait(1);
    expect((await state(app)).available).toEqual({ listening: true, automatic: false });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 41 * 1000);
    expect((await state(app)).available).toEqual({ listening: false, automatic: false });
  });

  it("takes a page's own request only when an Automatic connection listens", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    await agent(app, await issue(app, "when_asked")).wait(1);
    const byPage = await ask(app, "SUP-1", false);
    expect(byPage.status).toBe(409);
    expect(byPage.body.error.code).toBe("no_assistant_listening");
    await agent(app, await issue(app, "automatic", "Auto")).wait(1);
    expect((await state(app)).available).toEqual({ listening: true, automatic: true });
    expect((await ask(app, "SUP-1", false)).status).toBe(201);
  });

  it("does not count a revoked connection", async () => {
    const { app, db } = buildTestApp();
    await fileNoCheck(app);
    await agent(app, await issue(app, "when_asked")).wait(1);
    db.prepare("UPDATE agent_connections SET revoked_at = ?").run(new Date().toISOString());
    expect((await state(app)).available.listening).toBe(false);
  });
});

describe("who sees what", () => {
  it("the page's read says only its two facts and the request's state", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    await agent(app, await issue(app, "automatic", "Secret helper name")).wait(1);
    const res = await as(app, customerOne).get("/tickets/SUP-1/check-suggestions");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(Object.keys(res.body).sort()).toEqual(["available", "check_suggestions", "request"]);
    expect(Object.keys(res.body.available).sort()).toEqual(["automatic", "listening"]);
    expect(res.text).not.toContain("Secret helper name");
  });

  it("only the filer asks, and only the one who asked reads the request", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    await agent(app, await issue(app, "when_asked")).wait(1);
    expect((await ask(app, "SUP-1", true, teamActor)).status).toBe(403);
    expect((await ask(app, "SUP-1", true, customerTwo)).status).toBe(404);
    await ask(app);
    expect((await state(app)).request).toBe("waiting");
    expect((await state(app, "SUP-1", teamActor)).request).toBe("none");
    expect((await as(app, customerTwo).get("/tickets/SUP-1/check-suggestions")).status).toBe(404);
  });

  it("a connection whose setting does not allow a request never sees it or its ticket", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const whenAsked = agent(app, await issue(app, "when_asked", "Asked"));
    const automatic = agent(app, await issue(app, "automatic", "Auto"));
    const waits = [whenAsked.wait(2), automatic.wait(10)];
    await untilListening(app);
    await ask(app, "SUP-1", false);
    const [asked, auto] = await Promise.all(waits);
    expect(asked!.body).toEqual({ requests: [] });
    const id = auto!.body.requests[0].id as number;
    const answer = await whenAsked.answer(id, ["Every row is there"]);
    expect(answer.status).toBe(404);
    expect(answer.body.error.code).toBe("request_not_found");
    expect(JSON.stringify(answer.body)).not.toContain(noCheck.title);
  });

  it("is only for a New ticket with no check", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ ...noCheck, fix_check: "Every row is there" });
    await agent(app, await issue(app, "when_asked")).wait(1);
    const res = await ask(app);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("check_exists");
  });
});

describe("the page route", () => {
  it("refuses a request that does not come from this site", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const res = await request(app)
      .post("/tickets/SUP-1/check-suggestions/request")
      .set("Cookie", `${DEV_COOKIE}=${customerOne.id}`)
      .set("Sec-Fetch-Site", "cross-site")
      .accept("json")
      .type("form")
      .send({ pressed: "true" });
    expect(res.status).toBe(403);
  });

  it("sends a form back to the ticket, with the reason when refused", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const browser = as(app, customerOne);
    const res = await browser
      .post("/tickets/SUP-1/check-suggestions/request")
      .type("form")
      .send({ pressed: "true" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1");
    expect((await browser.get("/tickets/SUP-1")).text).toContain(
      "No assistant is listening for requests right now.",
    );
  });
});

describe("a caller that goes away", () => {
  /** Starts a wait_for_requests call on a real port, and gives a way to walk away from it. */
  async function abandonable(app: Express, key: string, seconds: number) {
    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const leave = new AbortController();
    const done = fetch(`http://127.0.0.1:${port}/api/suggestion-requests?wait_seconds=${seconds}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: leave.signal,
    }).catch(() => "left");
    return {
      async leave() {
        leave.abort();
        expect(await done).toBe("left");
        // Give the server a moment to see the closed connection.
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    };
  }

  it("hands a request to the connection's next call, not to the call it walked away from", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const key = await issue(app, "when_asked");
    const first = await abandonable(app, key, 25);
    await untilListening(app);
    await first.leave();
    // The connection still counts as listening, so the customer may ask.
    const res = await ask(app);
    expect(res.status, res.text).toBe(201);
    const started = Date.now();
    const next = await agent(app, key).wait(3);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(next.body.requests.map((r: { key: string }) => r.key)).toEqual(["SUP-1"]);
  });

  it("frees its place at once, so a fifth caller is not refused because of it", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const keys = [];
    for (let n = 0; n <= MOST_HELD_CALLS; n += 1) {
      keys.push(await issue(app, "when_asked", `Helper ${n}`));
    }
    const gone = await abandonable(app, keys[0]!, 25);
    await untilListening(app);
    const held = keys.slice(1, MOST_HELD_CALLS).map((key) => agent(app, key).wait(3));
    // Every place is taken once the fifth is refused, so try until it is.
    const fifth = agent(app, keys[MOST_HELD_CALLS]!);
    let tried = await fifth.wait(1);
    for (let tries = 0; tries < 100 && tried.status === 200; tries += 1)
      tried = await fifth.wait(1);
    expect(tried.status).toBe(429);
    await gone.leave();
    expect((await fifth.wait(1)).status).toBe(200);
    await Promise.all(held);
  });

  it("still counts its connection as listening for 40 seconds after the call", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const first = await abandonable(app, await issue(app, "when_asked"), 25);
    await untilListening(app);
    await first.leave();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 39 * 1000);
    expect((await state(app)).available.listening).toBe(true);
    vi.setSystemTime(Date.now() + 2 * 1000);
    expect((await state(app)).available.listening).toBe(false);
  });

  it("over MCP, a call whose caller went away does not take the request from the next one", async () => {
    const { app } = buildTestApp();
    await fileNoCheck(app);
    const key = await issue(app, "when_asked");
    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;
    // A caller that sends one tool call and then walks away from it.
    const leave = new AbortController();
    const gone = fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "wait_for_requests", arguments: { wait_seconds: 25 } },
      }),
      signal: leave.signal,
    }).catch(() => "left");
    await untilListening(app);
    leave.abort();
    expect(await gone).toBe("left");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await ask(app)).status).toBe(201);
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    const started = Date.now();
    const next = await client.callTool({
      name: "wait_for_requests",
      arguments: { wait_seconds: 3 },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    const content = next.content as { text: string }[];
    const handed = JSON.parse(content[0]!.text).result.requests as { key: string }[];
    expect(handed.map((r) => r.key)).toEqual(["SUP-1"]);
  });
});

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import {
  ACTIVITY_KEPT,
  createConnectionService,
  DEMO_CONNECTION_LIMIT,
  type ConnectionService,
} from "../src/server/connections/service.js";
import { seedDemo } from "../src/server/demo.js";
import { WRITE_LIMIT } from "../src/server/limits.js";
import { createTicketService } from "../src/server/tickets/service.js";
import type { Db } from "../src/server/db.js";
import {
  admin,
  adminActor,
  buildTestApp,
  closeServers,
  handToAgent,
  listenLocally,
  visitor,
} from "./helpers.js";

// What an agent's key can make the server store, whatever it sends, on both doors, and how
// many demo connections a few visitors can hold.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

/** A read an agent made on SUP-1 through the API, as the routes record it. */
const read = (action: string) => ({
  door: "api" as const,
  action,
  ticketKey: "SUP-1",
  idempotencyKey: undefined,
  outcome: "done" as const,
  code: null,
});

/** How many activity rows each connection has, by connection id. */
const trails = (db: Db) =>
  db
    .prepare(
      "SELECT connection_id, COUNT(*) AS n FROM agent_activity GROUP BY connection_id ORDER BY connection_id",
    )
    .all();

/** A connection an admin issued, as the agent that holds its key. */
function agent(connections: ConnectionService, name: string) {
  return connections.authenticate(
    connections.create({ name, scopes: ["read_tickets"] }, adminActor).key,
  )!;
}

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
});

async function issue(app: Express, scopes: string[], name = "Helper") {
  const res = await admin(app).post("/connections").type("form").send({ name, scopes });
  return keyOnPage(res.text);
}

/** Starts the app on a free port and connects the SDK's client with this key. */
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

describe("an agent's activity trail", () => {
  it("stores a ticket key only in a key's form, and an idempotency key of at most 100 characters", async () => {
    const { app, db } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets"]);
    await handToAgent(app, "SUP-1", key);
    const get = (path: string, idempotencyKey: string) =>
      request(app)
        .get(path)
        .set("Authorization", `Bearer ${key}`)
        .set("Idempotency-Key", idempotencyKey);
    // A key with one digit more than its form allows, then an idempotency key one character
    // over the limit, then one at it.
    await get("/api/tickets/SUP-" + "9".repeat(17), "k");
    await get("/api/tickets/SUP-1", "k".repeat(101));
    await get("/api/tickets/SUP-1", "k".repeat(100));
    // Over MCP, a ticket key over 30 characters is refused before the tool runs, and nothing
    // is recorded.
    const client = await connect(app, key);
    const refused = await client.callTool({
      name: "get_ticket",
      arguments: { key: "SUP-" + "9".repeat(90_000) },
    });
    expect(refused.isError).toBe(true);
    const rows = db
      .prepare("SELECT ticket_key, LENGTH(idempotency_key) AS idem FROM agent_activity ORDER BY id")
      .all();
    expect(rows).toEqual([
      { ticket_key: null, idem: 1 },
      { ticket_key: "SUP-1", idem: null },
      { ticket_key: "SUP-1", idem: 100 },
    ]);
  });

  it("keeps only a connection's latest requests, and leaves another connection's alone", () => {
    const { db } = buildTestApp();
    const connections = createConnectionService(db, () => true);
    const busy = agent(connections, "Busy");
    const quiet = agent(connections, "Quiet");
    connections.record(quiet, read("get_ticket"));
    for (let i = 0; i < ACTIVITY_KEPT + 100; i++) connections.record(busy, read("get_ticket"));
    connections.record(busy, read("list_tickets"));
    expect(trails(db)).toEqual([
      { connection_id: busy.connection!.id, n: ACTIVITY_KEPT },
      { connection_id: quiet.connection!.id, n: 1 },
    ]);
    // The newest row is the busy connection's last request: the oldest rows went, not the new.
    const last = db
      .prepare("SELECT connection_id, action FROM agent_activity ORDER BY id DESC LIMIT 1")
      .get();
    expect(last).toEqual({ connection_id: busy.connection!.id, action: "list_tickets" });
  });

  it("finds rows over a month old by an index, not by reading the whole table", () => {
    const { db } = buildTestApp();
    const connections = createConnectionService(db, () => true);
    const helper = agent(connections, "Helper");
    // The statement the prune runs, as recording a request prepares it.
    const prepare = vi.spyOn(db, "prepare");
    connections.record(helper, read("get_ticket"));
    const prune = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.startsWith("DELETE") && sql.includes("created_at"));
    prepare.mockRestore();
    expect(prune).toBeDefined();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${prune!}`).all("2026-01-01T00:00:00.000Z") as {
      detail: string;
    }[];
    expect(plan.map((step) => step.detail).join(" ")).toMatch(
      /^SEARCH agent_activity USING (COVERING )?INDEX \w+ \(created_at<\?\)$/,
    );
  });

  it("tells an MCP client how long a ticket key may be", async () => {
    const { app } = buildTestApp();
    const client = await connect(app, await issue(app, ["read_tickets"]));
    const tool = (await client.listTools()).tools.find((t) => t.name === "get_ticket")!;
    expect(tool.inputSchema.properties?.key).toMatchObject({ type: "string", maxLength: 30 });
  });
});

describe("the demo's connections at its cap", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forget what an ended one did at the next one issued, so only live ones keep a trail", () => {
    const { db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const connections = createConnectionService(db, () => true);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T09:00:00.000Z"));
    const ended = connections.authenticate(connections.issueDemo().key)!;
    const revoked = agent(connections, "Helper");
    vi.setSystemTime(new Date("2026-11-18T08:00:00.000Z"));
    const live = connections.authenticate(connections.issueDemo().key)!;
    for (const actor of [ended, revoked, live]) connections.record(actor, read("get_ticket"));
    // An admin's connection keeps its trail after it is revoked, as before.
    connections.revoke(revoked.connection!.id, adminActor);

    // The first demo connection expires at 09:00. The next one issued forgets its trail.
    vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z"));
    connections.issueDemo();
    expect(trails(db)).toEqual([
      { connection_id: revoked.connection!.id, n: 1 },
      { connection_id: live.connection!.id, n: 1 },
    ]);
  });

  it("make room by ending the one issued first, however recently it was used", () => {
    const { db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const connections = createConnectionService(db, () => true);
    vi.useFakeTimers({ toFake: ["Date"] });
    // This one has expired by the time the demo is full: it is neither counted nor ended.
    vi.setSystemTime(new Date("2026-11-17T09:00:00.000Z"));
    connections.issueDemo();
    vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z"));
    const first = connections.issueDemo().key;
    vi.setSystemTime(new Date("2026-11-18T10:30:00.000Z"));
    const idle = connections.issueDemo().key;
    const others = Array.from(
      { length: DEMO_CONNECTION_LIMIT - 2 },
      () => connections.issueDemo().key,
    );
    // Every key but one is used, the first last of all: using a key does not keep it, so
    // holders keeping theirs busy cannot choose whose key a new one ends.
    vi.setSystemTime(new Date("2026-11-18T11:00:00.000Z"));
    others.forEach((key) => connections.authenticate(key));
    vi.setSystemTime(new Date("2026-11-18T11:30:00.000Z"));
    connections.record(connections.authenticate(first)!, read("get_ticket"));

    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    const newest = connections.issueDemo().key;
    expect(connections.authenticate(first)).toBeNull();
    // The ended one's trail goes with it.
    expect(trails(db)).toEqual([]);
    for (const key of [idle, others[0]!, newest]) {
      expect(connections.authenticate(key)).not.toBeNull();
    }
    const live = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_connections WHERE demo = 1 AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(new Date().toISOString()) as { n: number };
    expect(live.n).toBe(DEMO_CONNECTION_LIMIT);
  });
});

describe("the page that shows a new key", () => {
  // A signed-in admin's page is never kept already, like every signed-in page.
  it("is never kept by a demo visitor's browser, though the visitor is not signed in", async () => {
    const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(demo.db, demo.config.ticketPrefix));
    const shown = await visitor(demo.app).post("/demo/connection");
    expect(shown.text).toMatch(/Bearer pd_/);
    expect(shown.headers["cache-control"]).toBe("no-store");
  });
});

describe("a request to /mcp whose body the JSON parser did not read", () => {
  it("is refused, so no batch or write slips past the batch check and the allowance", async () => {
    const { app, db } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "write_notes"]);
    await handToAgent(app, "SUP-1", key);
    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const note = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "add_note", arguments: { key: "SUP-1", body: `note ${id}` } },
    });
    // fetch sends this no-break space as the single byte 0xA0. Express's JSON parser does not
    // take that type for JSON, but the SDK trims it off and would read the body itself.
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json\u00a0",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });
    for (const body of [[note(1), note(2)], note(3)]) {
      const res = await post(body);
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: expect.any(String), data: { code: "bad_request" } },
      });
    }
    const notes = db.prepare("SELECT COUNT(*) AS n FROM ticket_entries").get() as { n: number };
    expect(notes.n).toBe(0);
  });
});

describe("an error on /mcp before the SDK answers", () => {
  it("comes back as a JSON-RPC error, never as a page", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "write_notes"]);
    await handToAgent(app, "SUP-1", key);
    const post = (body: string) =>
      request(app)
        .post("/mcp")
        .set("Authorization", `Bearer ${key}`)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .send(body);
    const note = (body: string) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "add_note", arguments: { key: "SUP-1", body } },
      });
    const asJsonRpc = (res: request.Response, status: number, code: string) => {
      expect(res.status).toBe(status);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.body).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: expect.any(String), data: { code } },
      });
    };

    asJsonRpc(await post("{bad"), 400, "bad_request");
    asJsonRpc(await post(note("x".repeat(101 * 1024))), 413, "bad_request");
    for (let i = 0; i < WRITE_LIMIT; i++) {
      await request(app)
        .post("/api/tickets/SUP-1/entries")
        .set("Authorization", `Bearer ${key}`)
        .send({ kind: "note", body: `note ${i}` });
    }
    const over = await post(note("one more"));
    asJsonRpc(over, 429, "too_many_requests");
    expect(over.headers["retry-after"]).toMatch(/^\d+$/);
    expect(over.body.error.data.retry).toBe(true);
  });
});

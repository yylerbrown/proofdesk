import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectionService,
  DEMO_CONNECTION_LIMIT,
} from "../src/server/connections/service.js";
import { admin, buildTestApp, closeServers, handToAgent, listenLocally } from "./helpers.js";

// What an agent's key can make the server store, whatever it sends, on both doors, and how
// many demo connections a few visitors can hold.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };
// A connection's activity trail keeps its latest 1,000 requests.
const KEPT = 1000;
const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
});

async function issue(app: Express, scopes: string[], name = "Helper") {
  const res = await admin(app).post("/connections").type("form").send({ name, scopes });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
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
  it("stores no long ticket key or idempotency key, on either door", async () => {
    const { app, db } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets"]);
    await handToAgent(app, "SUP-1", key);
    const client = await connect(app, key);
    await client
      .callTool({ name: "get_ticket", arguments: { key: "SUP-" + "x".repeat(90_000) } })
      .catch(() => {});
    await request(app)
      .get("/api/tickets/SUP-" + "9".repeat(5_000))
      .set("Authorization", `Bearer ${key}`);
    await request(app)
      .get("/api/tickets/SUP-1")
      .set("Authorization", `Bearer ${key}`)
      .set("Idempotency-Key", "k".repeat(10_000));
    const widest = db
      .prepare(
        "SELECT MAX(LENGTH(COALESCE(ticket_key, '')) + LENGTH(COALESCE(idempotency_key, ''))) AS n FROM agent_activity",
      )
      .get() as { n: number };
    expect(widest.n).toBeLessThanOrEqual(130);
  });

  it("keeps only a connection's latest requests, and leaves another connection's alone", async () => {
    const { app, db } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const busy = await issue(app, ["read_tickets"], "Busy");
    const quiet = await issue(app, ["read_tickets"], "Quiet");
    await handToAgent(app, "SUP-1", busy);
    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const read = (key: string, path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${key}` } });
    expect((await read(quiet, "/api/tickets")).status).toBe(200);
    for (let i = 0; i < KEPT + 100; i++) await read(busy, "/api/tickets/SUP-1");
    expect((await read(busy, "/api/tickets")).status).toBe(200);
    const rows = db
      .prepare(
        "SELECT c.name, COUNT(*) AS n FROM agent_activity a JOIN agent_connections c ON c.id = a.connection_id GROUP BY c.name ORDER BY c.name",
      )
      .all();
    expect(rows).toEqual([
      { name: "Busy", n: KEPT },
      { name: "Quiet", n: 1 },
    ]);
    // The newest row is the busy connection's last request: the oldest rows went, not the new.
    const last = db
      .prepare("SELECT action, ticket_key FROM agent_activity ORDER BY id DESC LIMIT 1")
      .get();
    expect(last).toEqual({ action: "list_tickets", ticket_key: null });
  });

  it("finds rows over a month old by an index, not by reading the whole table", () => {
    const { db } = buildTestApp();
    const plan = db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM agent_activity WHERE created_at < ?")
      .all("2026-01-01T00:00:00.000Z") as { detail: string }[];
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

  it("make room by ending the one used longest ago, so a new visitor is never turned away", () => {
    const { db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const connections = createConnectionService(db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z"));
    const keys = Array.from({ length: DEMO_CONNECTION_LIMIT }, () => connections.issueDemo().key);
    // Every connection is used later except the second, so the first, though issued first,
    // is not the one used longest ago.
    vi.setSystemTime(new Date("2026-11-18T11:00:00.000Z"));
    keys.filter((_, i) => i !== 1).forEach((key) => connections.authenticate(key));

    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    const newest = connections.issueDemo().key;
    expect(connections.authenticate(newest)).not.toBeNull();
    expect(connections.authenticate(keys[1]!)).toBeNull();
    expect(connections.authenticate(keys[0]!)).not.toBeNull();
    const live = db
      .prepare(
        "SELECT COUNT(*) AS n FROM agent_connections WHERE demo = 1 AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(new Date().toISOString()) as { n: number };
    expect(live.n).toBe(DEMO_CONNECTION_LIMIT);
  });
});

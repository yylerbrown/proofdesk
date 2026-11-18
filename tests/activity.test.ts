import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The activity trail: everything a connection asked for, done or refused, on both doors, and
// the team's view of it. And the history names an agent by its connection.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };
const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.close();
});

async function issue(app: Express, scopes: string[], name = "Night shift") {
  const res = await admin(app).post("/connections").type("form").send({ name, scopes });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

async function connect(app: Express, key: string) {
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: "t", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  clients.push(client);
  return client;
}

/** The rows of a connection's activity page, as the team sees them. */
async function activityRows(app: Express) {
  const list = parse((await as(app, teamActor).get("/connections")).text);
  const href = list.querySelector("tbody a[href^='/connections/']")!.getAttribute("href")!;
  const page = parse((await as(app, teamActor).get(href)).text);
  return page
    .querySelectorAll("table.activity tbody tr")
    .map((tr) => tr.querySelectorAll("td").map((td) => td.text.trim()));
}

describe("the activity trail", () => {
  it("records what an agent did and what it was refused, on both doors, with the idempotency key", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "write_notes"]);
    await request(app)
      .post("/api/tickets/SUP-1/entries")
      .set("Authorization", `Bearer ${key}`)
      .set("Idempotency-Key", "note-1")
      .send({ kind: "note", body: "Seen" });
    await request(app)
      .post("/api/tickets/SUP-1/entries")
      .set("Authorization", `Bearer ${key}`)
      .send({ kind: "reply", body: "Hi" });
    const client = await connect(app, key);
    await client.callTool({ name: "get_ticket", arguments: { key: "SUP-1" } });
    await client.callTool({
      name: "change_status",
      arguments: { key: "SUP-1", status: "resolved" },
    });

    const rows = await activityRows(app);
    // Newest first: How, What, Ticket, Result, Idempotency key.
    expect(rows.map((r) => r.slice(1))).toEqual([
      ["Tool", "change_status", "SUP-1", "Refused: needs_customer", ""],
      ["Tool", "get_ticket", "SUP-1", "Done", ""],
      ["API", "add_entry", "SUP-1", "Refused: forbidden", ""],
      ["API", "add_entry", "SUP-1", "Done", "note-1"],
    ]);
  });

  it("is for the team to see, not a customer", async () => {
    const { app } = buildTestApp();
    await issue(app, ["read_tickets"]);
    expect((await as(app, customerOne).get("/connections/1")).status).toBe(403);
    expect((await as(app, teamActor).get("/connections/1")).status).toBe(200);
  });

  it("holds no ticket text", async () => {
    const { app, db } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ ...valid, description: "SECRET-TEXT" });
    const key = await issue(app, ["read_tickets", "write_notes"]);
    await request(app)
      .post("/api/tickets/SUP-1/entries")
      .set("Authorization", `Bearer ${key}`)
      .send({ kind: "note", body: "SECRET-NOTE" });
    const rows = JSON.stringify(db.prepare("SELECT * FROM agent_activity").all());
    expect(rows).not.toContain("SECRET");
  });
});

describe("the history names an agent", () => {
  it("by its connection's name, marked as an AI agent", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "write_notes"]);
    await request(app)
      .post("/api/tickets/SUP-1/entries")
      .set("Authorization", `Bearer ${key}`)
      .send({ kind: "note", body: "Seen" });
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const who = page
      .querySelectorAll("table")
      .at(-1)!
      .querySelectorAll("tbody td:last-child")
      .map((td) => td.text);
    expect(who).toContain("Night shift (AI agent)");
    expect(who.join(" ")).not.toContain("connection-");
  });
});

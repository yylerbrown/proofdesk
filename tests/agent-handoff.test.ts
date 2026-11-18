import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, handToAgent, teamActor } from "./helpers.js";

// An agent works only on the tickets an owner has handed to its connection, through every
// door, and loses a ticket when it is handed on, the customer is asked, it is archived, the
// owner stops it, or the key is revoked.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};
const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.close();
});

async function issue(app: Express, name = "Helper") {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name, scopes: ["read_tickets", "write_notes", "attach_evidence"] });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

const asAgent = (app: Express, key: string) => ({
  get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${key}`),
  note: (ticket: string) =>
    request(app)
      .post(`/api/tickets/${ticket}/entries`)
      .set("Authorization", `Bearer ${key}`)
      .send({ kind: "note", body: "x" }),
});

async function twoTickets(app: Express) {
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ ...valid, title: "Invoice wrong" });
}

describe("what a connection can reach", () => {
  it("only the ticket handed to it, through every door", async () => {
    const { app } = buildTestApp();
    await twoTickets(app);
    const key = await issue(app);
    await handToAgent(app, "SUP-1", key);
    const agent = asAgent(app, key);
    expect((await agent.get("/api/tickets")).body.map((t: { key: string }) => t.key)).toEqual([
      "SUP-1",
    ]);
    for (const path of ["", "/entries", "/events", "/evidence"]) {
      expect((await agent.get(`/api/tickets/SUP-2${path}`)).status, path).toBe(404);
      expect((await agent.get(`/api/tickets/SUP-1${path}`)).status, path).toBe(200);
    }
    expect((await agent.note("SUP-2")).status).toBe(404);
    expect((await agent.note("SUP-1")).status).toBe(201);

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
    const read = await client.callTool({ name: "get_ticket", arguments: { key: "SUP-2" } });
    expect(read.isError).toBe(true);
    const listed = await client.callTool({ name: "list_tickets", arguments: {} });
    expect((listed.content as { text: string }[])[0]!.text).not.toContain("SUP-2");
  });

  it("nothing at all until a ticket is handed to it", async () => {
    const { app } = buildTestApp();
    await twoTickets(app);
    const key = await issue(app);
    expect((await asAgent(app, key).get("/api/tickets")).body).toEqual([]);
    expect((await asAgent(app, key).get("/api/tickets/SUP-1")).status).toBe(404);
  });
});

describe("when access ends", () => {
  it.each([
    [
      "the owner stops it",
      async (app: Express) => as(app, teamActor).post("/api/tickets/SUP-1/agent/end"),
    ],
    [
      "the ticket is handed on",
      async (app: Express) =>
        as(app, teamActor)
          .post("/api/tickets/SUP-1/hand-off")
          .send({ to: "dev-admin-1", expected_owner: "dev-team-1" }),
    ],
    [
      "the ticket is archived",
      async (app: Express) => as(app, teamActor).post("/api/tickets/SUP-1/archive"),
    ],
    [
      "the customer is asked",
      async (app: Express) => {
        await as(app, teamActor)
          .put("/api/tickets/SUP-1/change-link")
          .send({ change_url: "https://example.com/c" });
        return as(app, teamActor)
          .post("/api/tickets/SUP-1/ready")
          .send({ try_url: "https://example.com/t", tried: "Printed it.", result: "Fine." });
      },
    ],
  ])("the old key loses the ticket when %s", async (_why, end) => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const key = await issue(app);
    await handToAgent(app, "SUP-1", key);
    expect((await asAgent(app, key).get("/api/tickets/SUP-1")).status).toBe(200);
    const ended = await end(app);
    expect(ended.status).toBeLessThan(400);
    expect((await asAgent(app, key).get("/api/tickets/SUP-1")).status).toBe(404);
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.map((e) => e.type)).toContain("agent_handoff_ended");
  });

  it("the key is revoked", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const key = await issue(app);
    await handToAgent(app, "SUP-1", key);
    const page = parse((await admin(app).get("/connections")).text);
    await admin(app).post(page.querySelector("form[action$='/revoke']")!.getAttribute("action")!);
    expect((await asAgent(app, key).get("/api/tickets/SUP-1")).status).toBe(401);
  });
});

describe("handing a ticket to an agent", () => {
  it("is for the owner of an in-progress ticket, to a live connection", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await issue(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const notStarted = await as(app, teamActor)
      .post("/api/tickets/SUP-1/agent")
      .send({ connection_id: 1 });
    expect(notStarted.status).toBe(409);
    await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    const notOwner = await admin(app).post("/api/tickets/SUP-1/agent").send({ connection_id: 1 });
    expect(notOwner.status).toBe(403);
    const unknown = await as(app, teamActor)
      .post("/api/tickets/SUP-1/agent")
      .send({ connection_id: 99 });
    expect(unknown.status).toBe(400);
    const given = await as(app, teamActor)
      .post("/api/tickets/SUP-1/agent")
      .send({ connection_id: 1 });
    expect(given.status).toBe(200);
  });

  it("shows on the page who is working on it, with a way to stop it", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await issue(app, "Night shift");
    const before = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(before.querySelector("form[action$='/agent'] option")?.text).toBe("Night shift");
    await as(app, teamActor).post("/tickets/SUP-1/agent").type("form").send({ connection_id: "1" });
    const after = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(after.querySelector(".agent-help")?.text).toContain(
      "Night shift (AI assistant) is working on it",
    );
    expect(after.querySelector("form[action$='/agent/end'] button")?.text).toBe(
      "Stop the assistant",
    );
    expect(after.querySelector("main")?.text).toContain("Handed to the AI assistant Night shift");
    expect(
      parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
        "form[action$='/agent']",
      ),
    ).toBeNull();
  });
});

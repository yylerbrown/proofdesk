import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import { parse } from "node-html-parser";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ACTORS, type Actor } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { keyOnPage } from "./key-on-page.js";
import {
  admin,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  customerTwo,
  handToAgent,
  listenLocally,
  teamActor,
} from "./helpers.js";

// The list's one search box finds words in any order and in any form: "signing phone" finds
// "Cannot sign in on my phone". It matches word forms, not meanings. Everything the plain text
// search found before is still found, and who may see which ticket does not change.

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
});

const demoTeam = DEMO_ACTORS[1]!;

/** A demo server with its sample tickets, as it starts. */
function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

/** The titles the JSON API lists for this search. */
async function apiTitles(app: Express, who: Actor, q: string): Promise<string[]> {
  const res = await as(app, who).get(`/api/tickets?q=${encodeURIComponent(q)}`);
  expect(res.status, q).toBe(200);
  return (res.body as { title: string }[]).map((ticket) => ticket.title);
}

/** The text of each row the list page shows at this address. */
async function pageRows(app: Express, who: Actor, address: string): Promise<string[]> {
  const res = await as(app, who).get(address);
  expect(res.status, address).toBe(200);
  return parse(res.text)
    .querySelectorAll("table.tickets tbody tr")
    .map((row) => row.text.replace(/\s+/g, " ").trim());
}

describe("searching the demo's sample tickets by words", () => {
  const cases = [
    ["sign in phone", "Cannot sign in on my phone"],
    ["signing phone", "Cannot sign in on my phone"],
    ["phone sign", "Cannot sign in on my phone"],
    ["password email", "Password reset email never arrives"],
    ["reset pass", "Password reset email never arrives"],
  ] as const;

  it("finds every word in any order and any form, in the JSON API", async () => {
    const { app } = buildDemo();
    for (const [q, title] of cases) {
      expect(await apiTitles(app, demoTeam, q), q).toEqual([title]);
    }
  });

  it("finds the same tickets on the list page", async () => {
    const { app } = buildDemo();
    for (const [q, title] of cases) {
      const address = `/tickets?q=${encodeURIComponent(q)}`;
      const rows = await pageRows(app, demoTeam, address);
      expect(rows, q).toHaveLength(1);
      expect(rows[0], q).toContain(title);
    }
  });
});

describe("searching by words, with the development entrance", () => {
  /** Customer one files two tickets and customer two files one that shares their words. */
  async function setup() {
    const built = buildTestApp();
    const one = as(built.app, customerOne);
    await one.post("/api/tickets").send({ title: "Cannot sign in on my phone", description: "x" });
    await one
      .post("/api/tickets")
      .send({ title: "Invoice date wrong", description: "The emails show last month" });
    await as(built.app, customerTwo)
      .post("/api/tickets")
      .send({ title: "Signing in fails", description: "On my new phone" });
    return built;
  }

  it("looks in the description too, and needs every word", async () => {
    const { app } = await setup();
    expect(await apiTitles(app, teamActor, "email month")).toEqual(["Invoice date wrong"]);
    expect(await apiTitles(app, teamActor, "email phone")).toEqual([]);
    expect((await apiTitles(app, teamActor, "sign phone")).sort()).toEqual([
      "Cannot sign in on my phone",
      "Signing in fails",
    ]);
  });

  it("finds only a customer's own tickets, in the rows and in the counts", async () => {
    const { app } = await setup();
    expect(await apiTitles(app, customerOne, "sign phone")).toEqual(["Cannot sign in on my phone"]);
    expect(await apiTitles(app, customerTwo, "sign phone")).toEqual(["Signing in fails"]);
    // Another customer's words find nothing, exactly as words nobody wrote.
    expect(await apiTitles(app, customerOne, "fails")).toEqual([]);
    const page = parse((await as(app, customerOne).get("/tickets?q=fails")).text);
    expect(page.querySelector("p.empty")?.text).toBe('No tickets match "fails". Clear the search.');
    const counts = page
      .querySelectorAll("nav[aria-label='Filter by status'] a .filter-count")
      .map((count) => count.text.trim());
    expect(counts).toHaveLength(4);
    expect(counts.every((count) => count === "0")).toBe(true);
  });

  it("searches archived tickets on the Archived tab", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-3/archive");
    expect(await apiTitles(app, teamActor, "signing phone")).toEqual([
      "Cannot sign in on my phone",
    ]);
    const archived = await pageRows(app, teamActor, "/tickets?status=archived&q=phone%20signs");
    expect(archived).toHaveLength(1);
    expect(archived[0]).toContain("Signing in fails");
  });

  it("finds an assistant's own tickets by words in list_tickets, and no others", async () => {
    const { app } = await setup();
    const issued = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets"] });
    const key = keyOnPage(issued.text);
    await handToAgent(app, "SUP-1", key);

    const server = await listenLocally(app);
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    await client.connect(transport);
    clients.push(client);

    const result = await client.callTool({ name: "list_tickets", arguments: { q: "phone sign" } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    const items = JSON.parse(text).result.items as { key: string }[];
    expect(items.map((ticket) => ticket.key)).toEqual(["SUP-1"]);
  });
});

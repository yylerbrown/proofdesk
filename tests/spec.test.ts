import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  handToAgent,
  listenLocally,
  teamActor,
  visitor,
} from "./helpers.js";

// A test spec: an agent proposes one, a person on the team accepts or discards it, the
// customer reads it. It is a suggestion until accepted and never changes the status.

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
});

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

const spec = (marker = "") => ({
  summary: `Printing ten pages in a row works, from a full tray and from the manual slot. ${marker}`,
  scenarios: [
    {
      title: "Ten pages from the tray",
      given: "a full paper tray",
      when: "ten pages are printed in one job",
      then: "all ten come out and none jams",
      test_name: "prints ten pages from the tray",
    },
    {
      title: "Ten pages from the manual slot",
      given: "paper in the manual slot",
      when: "ten pages are printed in one job",
      then: "all ten come out and none jams",
    },
  ],
});

async function issue(app: Express): Promise<string> {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "attach_evidence", "propose_specs"] });
  const key = keyOnPage(res.text);
  // The owner hands SUP-1 to this connection, when there is one: agents see only those.
  if ((await admin(app).get("/api/tickets/SUP-1")).status === 200) {
    await handToAgent(app, "SUP-1", key);
  }
  return key;
}

async function connect(app: Express, given?: string): Promise<Client> {
  const key = given ?? (await issue(app));
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

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, body: JSON.parse(text) };
}

/** An app with SUP-1, filed by customer one and owned by the team member. */
async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take");
  await as(built.app, teamActor).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
  return built;
}

describe("proposing a spec", () => {
  it("is told by get_ticket when there is none, and then reads the one it proposed", async () => {
    const { app } = await setup();
    const client = await connect(app);
    const before = await call(client, "get_ticket", { key: "SUP-1" });
    expect(before.body.result.spec).toBeNull();
    const tool = (await client.listTools()).tools.find((t) => t.name === "propose_spec")!;
    expect(tool.description).toContain("make the customer's check testable");
    expect(tool.description).toContain("Do not invent requirements the customer did not ask for");

    const proposed = await call(client, "propose_spec", { key: "SUP-1", ...spec() });
    expect(proposed.isError).toBe(false);
    expect(proposed.body.result).toMatchObject({
      state: "proposed",
      coverage: { scenarios: 2, with_evidence: 0 },
      proposed_by: { kind: "agent", name: "Helper" },
      verified_by_proofdesk: false,
    });
    const after = await call(client, "get_ticket", { key: "SUP-1" });
    expect(after.body.result.spec.scenarios[0]).toMatchObject({
      number: 1,
      title: "Ten pages from the tray",
      test_name: "prints ten pages from the tray",
    });
  });

  it("never changes the status, whoever proposes or accepts it", async () => {
    const { app } = await setup();
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec() });
    await as(app, teamActor).post("/tickets/SUP-1/spec/decision").type("form").send({
      decision: "accept",
    });
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", waiting_on: "team", ready_at: null });
  });

  it("replaces the one before, which is kept in the history", async () => {
    const { app, db } = await setup();
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec("first") });
    await call(client, "propose_spec", { key: "SUP-1", ...spec("second") });
    const rows = db.prepare("SELECT state, summary FROM ticket_specs ORDER BY id").all() as {
      state: string;
      summary: string;
    }[];
    expect(rows.map((row) => row.state)).toEqual(["replaced", "proposed"]);
    expect(rows[0]!.summary).toContain("first");
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[];
    expect(events.filter((event) => event.type === "spec_proposed")).toHaveLength(2);
    const current = (await admin(app).get("/api/tickets/SUP-1")).body.spec;
    expect(current.summary).toContain("second");
  });

  it("is refused a spec with no scenarios, and to an agent without the scope", async () => {
    const { app } = await setup();
    const client = await connect(app);
    // The SDK checks the arguments against the tool's schema before the service sees them.
    const empty = await client.callTool({
      name: "propose_spec",
      arguments: { key: "SUP-1", summary: "x", scenarios: [] },
    });
    expect(empty.isError).toBe(true);
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Reader", scopes: ["read_tickets"] });
    const key = keyOnPage(res.text);
    await handToAgent(app, "SUP-1", key);
    const refused = await request(app)
      .post("/api/tickets/SUP-1/spec")
      .set("Authorization", `Bearer ${key}`)
      .send(spec());
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("forbidden");
  });
});

describe("deciding on a spec", () => {
  it("is for the team: the customer sees a spec only once it is accepted, and cannot accept it", async () => {
    const { app } = await setup();
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec() });

    // A proposed spec is a suggestion for the team: not on the customer's page or API.
    const customerPage = await as(app, customerOne).get("/tickets/SUP-1");
    expect(customerPage.text).not.toContain("Ten pages from the tray");
    expect(customerPage.text).not.toContain("/spec/decision");
    const refused = await as(app, customerOne)
      .post("/api/tickets/SUP-1/spec/decision")
      .send({ decision: "accept" });
    expect(refused.status).toBe(403);
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).body.spec).toBeNull();
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.spec.state).toBe("proposed");

    const teamPage = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(teamPage.querySelectorAll("form[action='/tickets/SUP-1/spec/decision']")).toHaveLength(
      2,
    );
    const accepted = await as(app, teamActor)
      .post("/tickets/SUP-1/spec/decision")
      .type("form")
      .send({ decision: "accept" });
    expect(accepted.status).toBe(303);
    // After the decision the card says how it ended in one line, with nothing left to press.
    for (const who of [customerOne, teamActor]) {
      const card = parse((await as(app, who).get("/tickets/SUP-1")).text).querySelector(
        ".assistant-card",
      )!;
      // Accepting saves the test; it does not say the fix works.
      expect(card.querySelector(".card-outcome")?.text).toBe("Test saved for the team to run.");
      expect(card.querySelectorAll("form")).toHaveLength(0);
    }
  });

  it("can be discarded, and the ticket then offers to ask for a new one", async () => {
    const { app } = await setup();
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec() });
    await as(app, teamActor)
      .post("/tickets/SUP-1/spec/decision")
      .type("form")
      .send({ decision: "discard" });
    expect((await admin(app).get("/api/tickets/SUP-1")).body.spec).toBeNull();
    const card = parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
      ".assistant-card",
    )!;
    expect(card.querySelector(".card-outcome")?.text).toBe(
      "The suggested test was discarded by Team Member.",
    );
    expect(card.querySelectorAll("form")).toHaveLength(0);
  });
});

describe("a spec a person proposed", () => {
  it("is headed with their name, before and after it is discarded", async () => {
    const { app } = await setup();
    await as(app, teamActor).post("/api/tickets/SUP-1/spec").send(spec()).expect(201);
    const from = async () =>
      parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
        ".assistant-card .card-from",
      )?.text;
    expect(await from()).toBe("From Team Member");
    await as(app, teamActor)
      .post("/tickets/SUP-1/spec/decision")
      .type("form")
      .send({ decision: "discard" });
    expect(await from()).toBe("From Team Member");
  });
});

describe("the spec on the ticket page", () => {
  it("offers no line asking an assistant for a spec, to anyone", async () => {
    const { app } = await setup();
    // The API and the assistant tools still take a spec; the page no longer advertises one.
    for (const agent of [as(app, teamActor), admin(app), as(app, customerOne)]) {
      const page = (await agent.get("/tickets/SUP-1")).text;
      expect(page).not.toContain("spec-prompt");
      expect(page).not.toContain("spec this ticket");
      expect(page).not.toContain("write a test spec");
    }
  });

  it("is one card with no headings: one sentence, the decision, and the rest under Details", async () => {
    const { app } = await setup();
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec() });
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const card = page.querySelector(".ticket-page .assistant-card")!;
    expect(card.querySelectorAll("h2, h3")).toHaveLength(0);
    expect(card.querySelector(".card-from")?.text).toBe("From the AI assistant");
    expect(card.querySelector(".card-proposal")?.text).toContain(
      "Printing ten pages in a row works",
    );
    expect(card.querySelectorAll(".card-decision button").map((b) => b.text)).toEqual([
      "Accept test",
      "Discard",
    ]);
    const details = card.querySelector("details.card-details")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.text).toBe("Details");
    expect(details.text).toContain(
      "2 scenarios, proposed by Helper (AI assistant). Reported, not verified by Proofdesk.",
    );
    expect(details.querySelectorAll(".scenarios li")).toHaveLength(2);
    expect(page.querySelector(".spec-prompt")).toBeNull();
  });

  it("keeps the scenario count out of the customer's box, which is one quote and two buttons", async () => {
    const { app } = await setup();
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec() });
    const attached = await call(client, "add_evidence", {
      key: "SUP-1",
      kind: "test",
      summary: "Ten pages from the tray printed",
      scenario: 1,
    });
    expect(attached.body.result.scenario).toBe(1);
    const beyond = await call(client, "add_evidence", {
      key: "SUP-1",
      kind: "test",
      summary: "x",
      scenario: 3,
    });
    expect(beyond.body.error.code).toBe("validation_error");

    // The team accepts it, so the customer may see it, then asks, so the box appears.
    await as(app, teamActor)
      .post("/tickets/SUP-1/spec/decision")
      .type("form")
      .send({ decision: "accept" });
    const team = as(app, teamActor);
    await team.put("/api/tickets/SUP-1/change-link").send({ change_url: "https://e.com/c/1" });
    await team
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://e.com/try", tried: "I printed ten pages.", result: "No jam." });
    const box = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    )!;
    // The question stays one quote and two buttons: the count stays in the API, not in the box.
    expect(box.text).not.toContain("scenarios in the agreed test spec");
    expect(box.innerHTML).not.toMatch(/✓|badge|passed all/i);
  });

  it("refuses evidence naming a scenario on a ticket with no spec", async () => {
    const { app } = await setup();
    const client = await connect(app);
    const res = await call(client, "add_evidence", {
      key: "SUP-1",
      kind: "test",
      summary: "x",
      scenario: 1,
    });
    expect(res.body.error.code).toBe("no_spec");
  });
});

describe("permanent deletion", () => {
  it("removes the spec, leaving its text nowhere on disk", async () => {
    const { app, db } = await setup();
    const marker = "SPEC-MARKER-77d1";
    const client = await connect(app);
    await call(client, "propose_spec", { key: "SUP-1", ...spec(marker) });
    const onDisk = () =>
      [db.name, `${db.name}-wal`]
        .filter(fs.existsSync)
        .some((file) => fs.readFileSync(file).includes(marker));
    db.pragma("wal_checkpoint(PASSIVE)");
    expect(onDisk()).toBe(true);
    const res = await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(res.body).toEqual({ deleted: true, files_cleaned: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_specs").get()).toEqual({ n: 0 });
    expect(onDisk()).toBe(false);
  });
});

describe("test specs on the demo", () => {
  function buildDemo() {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    // The seed records the sample's key, so no test names a fixed number for it.
    return { ...built, sample: service.assistantSampleKey() ?? "none" };
  }
  async function demoKey(app: Express): Promise<string> {
    const res = await visitor(app).post("/demo/connection");
    return keyOnPage(res.text);
  }
  it("never shows one connection the spec another proposed", async () => {
    const { app, sample } = buildDemo();
    const marker = "SPEC-FROM-A-90ad";
    const a = await connect(app, await demoKey(app));
    const b = await connect(app, await demoKey(app));
    const proposed = await call(a, "propose_spec", { key: sample, ...spec(marker) });
    expect(proposed.isError).toBe(false);
    expect((await call(a, "get_ticket", { key: sample })).body.result.spec.summary).toContain(
      marker,
    );
    expect((await call(b, "get_ticket", { key: sample })).body.result.spec).toBeNull();
    for (const tool of ["get_ticket", "list_events", "list_entries", "list_evidence"]) {
      const result = await b.callTool({ name: tool, arguments: { key: sample } });
      expect(JSON.stringify(result.content), tool).not.toContain(marker);
    }
    // The demo's team sees it on the ticket page, as a suggestion.
    const page = await visitor(app)
      .set("Cookie", `${DEV_COOKIE}=demo-team`)
      .get(`/tickets/${sample}`);
    expect(page.text).toContain(marker);
    expect(page.text).toContain("Reported, not verified");
  });

  it("offers the demo's team no line asking an assistant for a spec, even on the sample", async () => {
    const { app, sample } = buildDemo();
    const as = (id: string, key: string) =>
      visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`).get(`/tickets/${key}`);
    for (const [id, key] of [
      ["demo-customer", sample],
      ["demo-team", sample],
      ["demo-team", "SUP-3"],
    ]) {
      expect(parse((await as(id!, key!)).text).querySelector(".spec-prompt")).toBeNull();
    }
  });
});

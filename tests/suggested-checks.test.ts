import fs from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { SUGGEST_CHECKS_TEXT } from "../src/server/api/describe.js";
import { loadConfig } from "../src/server/config.js";
import { insertConnection } from "../src/server/connections/repository.js";
import { DEFAULT_SCOPES, DEMO_SCOPES } from "../src/server/connections/service.js";
import { createDemoReset } from "../src/server/demo-reset.js";
import { openSite } from "../src/server/start.js";
import { keyOnPage } from "./key-on-page.js";
import {
  admin,
  as,
  buildTestApp,
  closeServers,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  handToAgent,
  listenLocally,
  teamActor,
  visitor,
} from "./helpers.js";

// Ways to verify a new ticket, suggested by an assistant an admin allowed to, and the customer's
// pick. The assistant reads only a little of each New ticket that has no check, and its words
// reach the ticket's check only when the customer chooses them.

const noCheck = { title: "Export is empty", description: "The monthly export has no rows." };
const withCheck = { ...noCheck, fix_check: "The export has every row" };

const servers: Server[] = [];
const clients: Client[] = [];
const folders: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  await closeServers(servers);
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

async function issue(app: Express, scopes: string[], name = "Helper") {
  const res = await admin(app).post("/connections").type("form").send({ name, scopes });
  return keyOnPage(res.text);
}

// A connection whose suggestion setting is Automatic, which holds both suggestion scopes.
const SUGGESTER = ["read_tickets", "suggest_when_asked", "suggest_automatic"];

function agent(app: Express, key: string) {
  return {
    get: (url: string) => request(app).get(url).set("Authorization", `Bearer ${key}`),
    suggest: (ticketKey: string, options: unknown) =>
      request(app)
        .post(`/api/tickets/${ticketKey}/check-suggestions`)
        .set("Authorization", `Bearer ${key}`)
        .send({ options }),
  };
}

/** A customer files a ticket and an allowed assistant suggests these ways to verify it. */
async function suggested(options: string[] = ["I export this month and every row is there"]) {
  const built = buildTestApp();
  const { app } = built;
  await as(app, customerOne).post("/api/tickets").send(noCheck);
  const key = await issue(app, SUGGESTER);
  const res = await agent(app, key).suggest("SUP-1", options);
  expect(res.status, res.text).toBe(201);
  return { ...built, key, offered: res.body.suggestions as { id: number; words: string }[] };
}

function countRows(db: { prepare: (sql: string) => { get: () => unknown } }): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM check_suggestions").get() as { n: number }).n;
}

describe("the suggestion setting an admin gives a connection", () => {
  it("is Off by default, a choice of three on the page, and never on a demo connection", async () => {
    for (const scope of ["suggest_when_asked", "suggest_automatic"]) {
      expect(DEFAULT_SCOPES).not.toContain(scope);
      expect(DEMO_SCOPES).not.toContain(scope);
    }
    const { app } = buildTestApp();
    const page = parse((await admin(app).get("/connections")).text);
    const choices = page.querySelectorAll("input[name='suggestions']");
    expect(choices.map((choice) => choice.getAttribute("value"))).toEqual([
      "off",
      "when_asked",
      "automatic",
    ]);
    expect(choices.map((choice) => choice.parentNode!.text.split(":")[0]!.trim())).toEqual([
      "Off",
      "When asked",
      "Automatic",
    ]);
    expect(choices[0]!.hasAttribute("checked")).toBe(true);
    // The two scopes behind it are not offered as boxes of their own.
    expect(page.querySelectorAll("input[name='scopes'][value^='suggest']")).toHaveLength(0);

    const demo = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const { createTicketService } = await import("../src/server/tickets/service.js");
    const { seedDemo } = await import("../src/server/demo.js");
    seedDemo(createTicketService(demo.db, demo.config.ticketPrefix));
    const demoKey = keyOnPage((await visitor(demo.app).post("/demo/connection")).text);
    const guide = (await agent(demo.app, demoKey).get("/api")).body;
    for (const scope of ["suggest_when_asked", "suggest_automatic"]) {
      expect(guide.you.scopes).not.toContain(scope);
    }
    for (const action of ["suggest_checks", "wait_for_requests", "answer_request"]) {
      expect(guide.you.may).not.toContain(action);
    }
  });

  it("stores each choice as the scopes it allows", async () => {
    const { app, db } = buildTestApp();
    const choose = (suggestions: string) =>
      admin(app)
        .post("/connections")
        .type("form")
        .send({ name: `Helper ${suggestions}`, scopes: ["read_tickets"], suggestions });
    for (const choice of ["off", "when_asked", "automatic"]) {
      expect((await choose(choice)).status).toBe(200);
    }
    const rows = db.prepare("SELECT scopes FROM agent_connections ORDER BY id").all() as {
      scopes: string;
    }[];
    expect(rows.map((row) => JSON.parse(row.scopes))).toEqual([
      ["read_tickets"],
      ["read_tickets", "suggest_when_asked"],
      ["read_tickets", "suggest_when_asked", "suggest_automatic"],
    ]);
    // The list of issued connections names what each may do.
    const page = (await admin(app).get("/connections")).text;
    expect(page).toContain("Suggest ways to verify a ticket when a person asks");
    expect(page).toContain("Suggest ways to verify new tickets without being asked");
  });

  it("needs reading the tickets too", async () => {
    const { app } = buildTestApp();
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["write_notes"], suggestions: "when_asked" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("Suggesting ways to verify needs reading the tickets too.");
    // The page keeps the choice that was made.
    const kept = parse(res.text).querySelector("input[name='suggestions'][value='when_asked']")!;
    expect(kept.hasAttribute("checked")).toBe(true);
  });
});

describe("what an allowed assistant reads", () => {
  it("lists exactly the key, title, description and filed time of New tickets with no check", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(noCheck); // SUP-1: wants a check
    await as(app, customerOne).post("/api/tickets").send(withCheck); // SUP-2: has one
    await as(app, customerOne).post("/api/tickets").send(noCheck); // SUP-3: started
    await as(app, teamActor).post("/api/tickets/SUP-3/take-and-start");
    await as(app, customerOne).post("/api/tickets").send(noCheck); // SUP-4: archived
    await as(app, customerOne).post("/api/tickets/SUP-4/archive");
    const key = await issue(app, SUGGESTER);

    const list = (await agent(app, key).get("/api/tickets")).body as Record<string, unknown>[];
    expect(list.map((row) => row.key)).toEqual(["SUP-1"]);
    expect(Object.keys(list[0]!).sort()).toEqual(["created_at", "description", "key", "title"]);
    const one = (await agent(app, key).get("/api/tickets/SUP-1")).body;
    expect(Object.keys(one).sort()).toEqual(["created_at", "description", "key", "title"]);
    expect(one.description).toBe(noCheck.description);
    // Nothing else about the ticket: not its conversation, history or evidence.
    for (const part of ["entries", "events", "evidence"]) {
      expect((await agent(app, key).get(`/api/tickets/SUP-1/${part}`)).status).toBe(404);
    }
    for (const other of ["SUP-2", "SUP-3", "SUP-4"]) {
      expect((await agent(app, key).get(`/api/tickets/${other}`)).status).toBe(404);
    }
  });

  it("is unchanged without the tick", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(noCheck);
    const key = await issue(app, DEFAULT_SCOPES);
    expect((await agent(app, key).get("/api/tickets")).body).toEqual([]);
    expect((await agent(app, key).get("/api/tickets/SUP-1")).status).toBe(404);
  });
});

describe("suggesting", () => {
  it("stores the ways offered, marked with the connection, and leaves the ticket's version", async () => {
    const { app, offered } = await suggested(["I export this month and every row is there"]);
    expect(offered).toEqual([
      {
        id: expect.any(Number),
        words: "I export this month and every row is there",
        offered_by: { kind: "agent", name: "Helper" },
        offered_at: expect.any(String),
        state: "offered",
      },
    ]);
    const ticket = (await as(app, customerOne).get("/api/tickets/SUP-1")).body;
    expect(ticket.version).toBe(1);
    expect(ticket.status).toBe("new");
    expect(ticket.owner_id).toBeNull();
    expect(ticket.check_suggestions).toEqual(offered);
  });

  it("is refused for a ticket with a check, a resolved one and an archived one, as not found", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withCheck); // SUP-1
    await as(app, customerOne).post("/api/tickets").send(noCheck); // SUP-2
    await as(app, teamActor)
      .post("/api/tickets/SUP-2/resolve")
      .send({ reason: "wont_fix", note: "As designed." });
    await as(app, customerOne).post("/api/tickets").send(noCheck); // SUP-3
    await as(app, customerOne).post("/api/tickets/SUP-3/archive");
    const key = await issue(app, SUGGESTER);
    for (const ticketKey of ["SUP-1", "SUP-2", "SUP-3", "SUP-99"]) {
      const res = await agent(app, key).suggest(ticketKey, ["I export and see every row"]);
      expect(res.status, ticketKey).toBe(404);
      expect(res.body.error.code).toBe("ticket_not_found");
    }
  });

  it("refuses four ways, an empty one and an over-long one", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(noCheck);
    const key = await issue(app, SUGGESTER);
    for (const options of [
      ["one way", "two way", "three way", "four way"],
      [],
      ["  "],
      ["x".repeat(201)],
    ]) {
      const res = await agent(app, key).suggest("SUP-1", options);
      expect(res.status, JSON.stringify(options)).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    }
  });

  it("is refused to a connection without the tick, and to people", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(noCheck);
    // Another connection's ticket: handed to that one, which has no tick either.
    await as(app, customerOne).post("/api/tickets").send(withCheck);
    const handed = await issue(app, DEFAULT_SCOPES, "Handed");
    await handToAgent(app, "SUP-2", handed);
    const plain = await issue(app, DEFAULT_SCOPES, "Plain");
    for (const key of [plain, handed]) {
      for (const ticketKey of ["SUP-1", "SUP-2"]) {
        const res = await agent(app, key).suggest(ticketKey, ["I export and see every row"]);
        expect(res.status, ticketKey).toBe(403);
      }
    }
    for (const who of [customerOne, teamActor]) {
      const res = await as(app, who)
        .post("/api/tickets/SUP-1/check-suggestions")
        .send({ options: ["I export and see every row"] });
      expect(res.status).toBe(403);
    }
  });

  it("replaces what the same connection offered, and holds three in all", async () => {
    const { app, key } = await suggested(["First way to check it", "Second way to check it"]);
    const again = await agent(app, key).suggest("SUP-1", ["A better way to check it"]);
    expect(again.status).toBe(201);
    expect(again.body.suggestions.map((s: { words: string }) => s.words)).toEqual([
      "A better way to check it",
    ]);
    const other = await issue(app, SUGGESTER, "Second helper");
    expect((await agent(app, other).suggest("SUP-1", ["Way two", "Way three"])).status).toBe(201);
    const full = await agent(app, other).suggest("SUP-1", ["Way two", "Way three", "Way four"]);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("suggestions_full");
    const all = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.check_suggestions;
    expect(all.map((s: { words: string }) => s.words)).toEqual([
      "A better way to check it",
      "Way two",
      "Way three",
    ]);
  });
});

describe("the customer's pick", () => {
  it("sets the check to a suggestion, marks it chosen and withdraws the others", async () => {
    const { app, offered } = await suggested(["Every row is there", "The file opens"]);
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ suggestion_id: offered[1]!.id, expected_version: 1 });
    expect(res.status, res.text).toBe(200);
    expect(res.body.fix_check).toBe("The file opens");
    const states = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.check_suggestions;
    expect(states.map((s: { state: string }) => s.state)).toEqual(["withdrawn", "chosen"]);
    const events = (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body;
    expect(events.at(-1)).toMatchObject({
      type: "check_chosen",
      data: { to: "The file opens", suggested_by: "Helper" },
    });
    const page = (await as(app, customerOne).get("/tickets/SUP-1")).text;
    expect(page).toContain("Customer chose what would prove it is fixed, suggested by Helper");
  });

  it("takes the customer's own words instead", async () => {
    const { app } = await suggested();
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ words: "I open the file and count the rows" });
    expect(res.body.fix_check).toBe("I open the file and count the rows");
    const states = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.check_suggestions;
    expect(states.map((s: { state: string }) => s.state)).toEqual(["withdrawn"]);
    expect((await as(app, customerOne).get("/tickets/SUP-1")).text).toContain(
      "Customer wrote what would prove it is fixed",
    );
  });

  it("is for the customer who filed it only", async () => {
    const { app, key, offered } = await suggested();
    const pick = { suggestion_id: offered[0]!.id };
    expect((await as(app, customerTwo).post("/api/tickets/SUP-1/check").send(pick)).status).toBe(
      404,
    );
    expect((await as(app, teamActor).post("/api/tickets/SUP-1/check").send(pick)).status).toBe(403);
    expect((await admin(app).post("/api/tickets/SUP-1/check").send(pick)).status).toBe(403);
    const byAgent = await request(app)
      .post("/api/tickets/SUP-1/check")
      .set("Authorization", `Bearer ${key}`)
      .send(pick);
    // The assistant is never handed the ticket, so for anything but suggesting it is not there.
    expect(byAgent.status).toBe(404);
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).body.fix_check).toBeNull();
  });

  it("saves the edited words and still marks the suggestion they started from chosen", async () => {
    const { app, offered } = await suggested(["Every row is there", "The file opens"]);
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ words: "Every row of March is there", suggestion_id: offered[0]!.id });
    expect(res.status, res.text).toBe(200);
    expect(res.body.fix_check).toBe("Every row of March is there");
    const states = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.check_suggestions;
    expect(states.map((s: { state: string }) => s.state)).toEqual(["chosen", "withdrawn"]);
    const events = (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body;
    expect(events.at(-1)).toMatchObject({
      type: "check_chosen",
      data: { from: null, to: "Every row of March is there", suggested_by: "Helper" },
    });
  });

  it("changes a check that is there as editing it does, and a repeat changes nothing", async () => {
    const { app, offered } = await suggested(["Every row is there", "The file opens"]);
    const first = { suggestion_id: offered[0]!.id };
    await as(app, customerOne).post("/api/tickets/SUP-1/check").send(first);
    const repeat = await as(app, customerOne).post("/api/tickets/SUP-1/check").send(first);
    expect(repeat.status).toBe(200);
    expect(repeat.body.version).toBe(2);
    // The team offers its wording and asks the customer; then the customer changes the check.
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/agreed-check")
      .send({ agreed_check: "The March export has 31 rows" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    const asked = (await as(app, customerOne).get("/api/tickets/SUP-1")).body;
    expect(asked.waiting_on).toBe("customer");
    const changed = await as(app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ words: "I count the rows myself" });
    expect(changed.status, changed.text).toBe(200);
    expect(changed.body.fix_check).toBe("I count the rows myself");
    expect(changed.body.agreed_check ?? null).toBeNull();
    expect(changed.body.waiting_on).not.toBe("customer");
    const events = (await as(app, customerOne).get("/api/tickets/SUP-1/events")).body as {
      type: string;
      data: Record<string, unknown>;
    }[];
    expect(events.find((event) => event.data.to === "I count the rows myself")).toMatchObject({
      type: "check_chosen",
      data: { from: "Every row is there", to: "I count the rows myself", suggested_by: null },
    });
    expect(events.at(-1)).toMatchObject({
      type: "check_agreed",
      data: { from: "The March export has 31 rows", to: null },
    });
  });

  it("refuses a withdrawn suggestion with no words of its own", async () => {
    const { app, offered } = await suggested(["Every row is there", "The file opens"]);
    await as(app, customerOne).post("/api/tickets/SUP-1/check").send({ words: "My own words" });
    const late = await as(app, customerOne)
      .post("/api/tickets/SUP-1/check")
      .send({ suggestion_id: offered[1]!.id });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("suggestion_gone");
  });
});

describe("once a ticket has a check", () => {
  it("withdraws what is offered, however the check was written, and takes no more", async () => {
    const { app, key } = await suggested();
    await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...noCheck, fix_check: "I count the rows myself" });
    const states = (await as(app, customerOne).get("/api/tickets/SUP-1")).body.check_suggestions;
    expect(states.map((s: { state: string }) => s.state)).toEqual(["withdrawn"]);
    expect((await agent(app, key).suggest("SUP-1", ["Another way to check"])).status).toBe(404);
  });
});

describe("who sees suggestions", () => {
  it("shows the filer and the team, never another customer, and an assistant only its own", async () => {
    const { app } = await suggested();
    expect((await admin(app).get("/api/tickets/SUP-1")).body.check_suggestions).toHaveLength(1);
    expect((await as(app, customerTwo).get("/api/tickets/SUP-1")).status).toBe(404);
    expect((await as(app, customerTwo).get("/tickets/SUP-1/check-suggestions")).status).toBe(404);
    // Another assistant later handed the ticket reads it in full, without the first one's words.
    const handed = await issue(app, DEFAULT_SCOPES, "Handed");
    await handToAgent(app, "SUP-1", handed);
    const read = (await agent(app, handed).get("/api/tickets/SUP-1")).body;
    expect(read.check_suggestions).toEqual([]);
  });

  it("are deleted with their ticket", async () => {
    const { app, db } = await suggested();
    expect(countRows(db)).toBe(1);
    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    expect(countRows(db)).toBe(0);
  });

  it("are cleared by the demo reset", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "support-desk-suggest-"));
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
    // No demo connection may suggest, so the row is written straight into the database.
    const connectionId = insertConnection(before, {
      name: "Helper",
      keyPrefix: "00000000",
      keyHash: "00",
      scopes: SUGGESTER,
      issuedBy: "someone",
      demo: false,
      now: new Date().toISOString(),
      expiresAt: null,
    });
    before
      .prepare(
        `INSERT INTO check_suggestions
           (ticket_id, connection_id, offered_by_name, words, state, created_at)
         VALUES (1, ?, 'Helper', 'Every row is there', 'offered', '2026-01-01')`,
      )
      .run(connectionId);
    expect(countRows(before)).toBe(1);
    clock.now += 25 * 60 * 60 * 1000;
    expect(reset.check()).toBe(true);
    const after = reset.current().db;
    expect(countRows(after)).toBe(0);
    after.close();
  });
});

describe("the assistant is told", () => {
  async function instructions(app: Express, key: string) {
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
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    return { text: client.getInstructions() ?? "", tools };
  }

  it("how to suggest, with the tick, in every place it reads", async () => {
    const { app } = buildTestApp();
    const key = await issue(app, SUGGESTER);
    const mcp = await instructions(app, key);
    expect(mcp.text).toContain(SUGGEST_CHECKS_TEXT);
    expect(mcp.tools).toContain("suggest_checks");
    expect((await agent(app, key).get("/api")).body.suggest_checks).toBe(SUGGEST_CHECKS_TEXT);
    const llms = await agent(app, key).get("/llms.txt");
    expect(llms.text).toContain(SUGGEST_CHECKS_TEXT);
    expect(llms.headers["cache-control"]).toBe("no-store");
  });

  it("nothing of it without the tick", async () => {
    const { app } = buildTestApp();
    const key = await issue(app, DEFAULT_SCOPES);
    const mcp = await instructions(app, key);
    expect(mcp.text).not.toContain(SUGGEST_CHECKS_TEXT);
    expect(mcp.tools).not.toContain("suggest_checks");
    expect((await agent(app, key).get("/api")).body.suggest_checks).toBeUndefined();
    expect((await agent(app, key).get("/llms.txt")).text).not.toContain(SUGGEST_CHECKS_TEXT);
    expect((await request(app).get("/llms.txt")).text).not.toContain(SUGGEST_CHECKS_TEXT);
  });
});

describe("the page routes", () => {
  const page = (app: Express, id: string) =>
    request.agent(app).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${id}`);

  it("save the customer's pick from a form and say so once", async () => {
    const { app, offered } = await suggested();
    const browser = page(app, customerOne.id);
    const res = await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({ suggestion_id: String(offered[0]!.id), words: "", expected_version: "1" });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets/SUP-1");
    const shown = await browser.get("/tickets/SUP-1");
    expect(shown.text).toContain("Saved. The team will check the fix against it.");
    expect((await browser.get("/tickets/SUP-1")).text).not.toContain(
      "Saved. The team will check the fix against it.",
    );
  });

  it("send a refusal back to the ticket with its reason", async () => {
    const { app } = await suggested();
    const browser = page(app, customerOne.id);
    const res = await browser.post("/tickets/SUP-1/check").type("form").send({ words: "" });
    expect(res.status).toBe(400);
    expect(res.text).toContain(
      "Pick one of the suggestions, or write how you will know it is fixed.",
    );
  });

  it("answer the suggestions as JSON for the filer and the team, kept by no cache", async () => {
    const { app } = await suggested();
    for (const id of [customerOne.id, teamActor.id]) {
      const res = await page(app, id).get("/tickets/SUP-1/check-suggestions");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.body.check_suggestions).toHaveLength(1);
      expect(res.body.check_suggestions[0].offered_by).toEqual({ kind: "agent", name: "Helper" });
    }
    expect((await page(app, customerTwo.id).get("/tickets/SUP-1/check-suggestions")).status).toBe(
      404,
    );
  });
});

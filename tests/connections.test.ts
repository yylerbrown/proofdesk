import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/server/api/actions.js";
import { WRITE_LIMIT } from "../src/server/app.js";
import { AGENT_SCOPES, CAPABILITIES } from "../src/server/permissions.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Connections for AI agents: issuing, the key shown once, signing in with it on the API,
// revoking, and the capability table enforced on the JSON door.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

/** Issues a connection through the admin's page and returns its key, read from the page. */
async function issue(app: Express, scopes: string[], name = "Sam's assistant") {
  const res = await admin(app).post("/connections").type("form").send({ name, scopes });
  expect(res.status).toBe(200);
  const key = parse(res.text).querySelector("input.key")?.getAttribute("value");
  expect(key).toMatch(/^pd_[0-9a-f]{8}_/);
  // One paste connects Claude Code, in the form its documentation gives.
  // The parser keeps a <pre> as raw text, so the command is read from the HTML.
  const command = /id="claude-code"><code>([^<]*)<\/code>/.exec(res.text)?.[1];
  expect(command).toBe(
    `claude mcp add --transport http proofdesk ${command?.split(" ")[6]} --header "Authorization: Bearer ${key}"`,
  );
  expect(command?.split(" ")[6]).toMatch(/^http:\/\/127\.0\.0\.1(:\d+)?\/mcp$/);
  // The example command quotes the address, so a shell does not read its "?" as a pattern.
  expect(parse(res.text).querySelectorAll("pre.paste").at(-1)?.text).toMatch(
    /"http[^"]+\?status=new"/,
  );
  return key!;
}

/** Requests to the JSON API as a program holding this key: no browser, no cookie. */
const agent = (app: Express, key: string) => ({
  get: (path: string) => request(app).get(path).set("Authorization", `Bearer ${key}`),
  send: (method: "post" | "put" | "patch" | "delete", path: string, body: object = {}) =>
    request(app)[method](path).set("Authorization", `Bearer ${key}`).send(body),
});

describe("issuing a connection", () => {
  it("shows the key once and stores only its hash", async () => {
    const { app, db } = buildTestApp();
    const key = await issue(app, ["read_tickets"]);
    const list = await admin(app).get("/connections");
    expect(list.text).not.toContain(key);
    expect(list.text).toContain(`pd_${key.split("_")[1]}`);
    const rows = JSON.stringify(db.prepare("SELECT * FROM agent_connections").all());
    expect(rows).not.toContain(key);
    // The secret part follows "pd_" and the 8-character prefix. It may itself contain "_".
    const secret = key.slice("pd_12345678_".length);
    expect(secret).toHaveLength(32);
    expect(rows).not.toContain(secret);
  });

  it("is for an admin only", async () => {
    const { app } = buildTestApp();
    for (const who of [teamActor, customerOne]) {
      expect((await as(app, who).get("/connections")).status).toBe(403);
      const res = await as(app, who)
        .post("/connections")
        .type("form")
        .send({ name: "x", scopes: "read_tickets" });
      expect(res.status).toBe(403);
    }
  });

  it("needs a name and at least one permission, and keeps what was typed", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).post("/connections").type("form").send({ name: "Mine" });
    expect(res.status).toBe(400);
    const html = parse(res.text);
    expect(html.querySelector("input[name=name]")?.getAttribute("value")).toBe("Mine");
    expect(html.querySelector("#scopes-error")?.text).toContain("at least one");
  });
});

describe("a connection key on the API", () => {
  it("lets the agent read, and refuses what its scopes do not name", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const key = await issue(app, ["read_tickets", "write_notes"]);
    const list = await agent(app, key).get("/api/tickets");
    expect(list.status).toBe(200);
    expect(list.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);
    const note = await agent(app, key).send("post", "/api/tickets/SUP-1/entries", {
      kind: "note",
      body: "Seen.",
    });
    expect(note.status, note.text).toBe(201);
    expect(note.body).toMatchObject({ author_kind: "agent", author_name: "Sam's assistant" });
    const reply = await agent(app, key).send("post", "/api/tickets/SUP-1/entries", {
      kind: "reply",
      body: "Hi",
    });
    expect(reply.status).toBe(403);
  });

  it("is refused when wrong, unknown or revoked, with a hint to issue a new one", async () => {
    const { app } = buildTestApp();
    const key = await issue(app, ["read_tickets"]);
    const unknown = `pd_00000000_${"a".repeat(32)}`;
    for (const bad of ["nonsense", unknown, `${key.slice(0, -1)}x`]) {
      const res = await agent(app, bad).get("/api/tickets");
      expect(res.status, bad).toBe(401);
      expect(res.body.error.code).toBe("invalid_connection_key");
    }
    const page = parse((await admin(app).get("/connections")).text);
    const revoke = page.querySelector("form[action$='/revoke']")?.getAttribute("action");
    expect((await admin(app).post(revoke!)).status).toBe(303);
    const after = await agent(app, key).get("/api/tickets");
    expect(after.status).toBe(401);
    expect(after.body.error.hint).toMatch(/revoke this connection and issue a new one/);
    expect((await admin(app).get("/connections")).text).toContain("Revoked");
  });

  it("does nothing on the pages: a key is not a browser sign-in", async () => {
    const { app } = buildTestApp();
    const key = await issue(app, [...AGENT_SCOPES]);
    const res = await request(app).get("/tickets").set("Authorization", `Bearer ${key}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toMatch(/^\/sign-in/);
  });

  it("records the connection, its issuer, its scopes and the ticket's owner on the history", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const key = await issue(app, ["read_tickets", "write_notes"]);
    await agent(app, key).send("post", "/api/tickets/SUP-1/entries", {
      kind: "note",
      body: "Seen.",
    });
    const events = (await admin(app).get("/api/tickets/SUP-1/events")).body;
    expect(events.at(-1)).toMatchObject({
      actor_kind: "agent",
      type: "note_added",
      context: {
        connection_name: "Sam's assistant",
        issued_by: "dev-admin-1",
        scopes: ["read_tickets", "write_notes"],
        ticket_owner: "dev-team-1",
      },
    });
    expect(events[0].context).toBeNull();
  });
});

// A body that would pass validation for each route, so a refusal can only be the permission.
const BODIES: Record<string, object> = {
  create_ticket: valid,
  edit_ticket: valid,
  agree_check: { agreed_check: "Ten pages print" },
  mark_ready: { try_url: "https://example.com/try" },
  answer: { fixed: "yes", ready_token: "x" },
  delete_ticket: { confirm: "SUP-1" },
};

describe("the capability table on the JSON door", () => {
  const peopleOnlyRoutes = ACTIONS.filter((row) =>
    [row.needs].flat().every((needed) => CAPABILITIES[needed].agent === "people_only"),
  );

  it("lists the people-only routes it checks", () => {
    expect(peopleOnlyRoutes.map((row) => row.name).sort()).toEqual(
      [
        "agree_check",
        "answer",
        "archive_ticket",
        "create_ticket",
        "delete_ticket",
        "edit_ticket",
        "mark_ready",
        "release_ticket",
        "restore_ticket",
        "take_ticket",
      ].sort(),
    );
  });

  it.each(peopleOnlyRoutes.map((row) => [row.name, row] as const))(
    "refuses %s to a key holding every scope",
    async (_name, row) => {
      const { app } = buildTestApp();
      await admin(app).post("/api/tickets").send(valid);
      const key = await issue(app, [...AGENT_SCOPES]);
      const path = `/api${row.path.replace(":key", "SUP-1")}`;
      const method = row.method === "get" ? "post" : row.method;
      const res = await agent(app, key).send(method, path, BODIES[row.name] ?? {});
      expect(res.status, `${row.method} ${path}: ${res.text}`).toBe(403);
    },
  );
});

describe("limits for a connection", () => {
  it("counts each connection's writes on its own, and refuses past the allowance", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const first = await issue(app, ["read_tickets", "write_notes"], "First");
    const second = await issue(app, ["read_tickets", "write_notes"], "Second");
    const note = { kind: "note", body: "x" };
    for (let i = 0; i < WRITE_LIMIT; i++) {
      await agent(app, first).send("post", "/api/tickets/SUP-1/entries", note);
    }
    const refused = await agent(app, first).send("post", "/api/tickets/SUP-1/entries", note);
    expect(refused.status).toBe(429);
    expect(refused.body.error).toMatchObject({ code: "too_many_requests", retry: true });
    const other = await agent(app, second).send("post", "/api/tickets/SUP-1/entries", note);
    expect(other.status).toBe(201);
  });
});

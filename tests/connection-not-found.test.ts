import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { createConnectionService } from "../src/server/connections/service.js";
import { HttpError } from "../src/server/errors.js";
import { can, type TicketFacts } from "../src/server/permissions.js";
import { adminActor, admin, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// Assistant connections that do not exist, or that only the demo issues: the activity page and
// revoking answer 404, a demo connection cannot be revoked by an admin, and the demo's own
// connection page is not there when the demo is off. Also an assistant whose connection names
// no scopes at all.

function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("Expected the call to be refused");
}

function service() {
  const { db } = buildTestApp();
  return { db, connections: createConnectionService(db, () => true) };
}

describe("a connection that is not there", () => {
  it("has no activity page", () => {
    const { connections } = service();
    const error = refusal(() => connections.activity(999, teamActor));
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
  });

  it("cannot be revoked", () => {
    const { connections } = service();
    expect(refusal(() => connections.revoke(999, adminActor)).status).toBe(404);
  });

  it("answers 404 through the page as well", async () => {
    const { app } = buildTestApp();
    expect((await admin(app).get("/connections/999")).status).toBe(404);
    expect((await admin(app).post("/connections/999/revoke")).status).toBe(404);
  });
});

describe("a demo visitor's connection", () => {
  it("cannot be revoked by an admin, and stays live", () => {
    const { connections } = service();
    const { connection, key } = connections.issueDemo();
    expect(refusal(() => connections.revoke(connection.id, adminActor)).status).toBe(404);
    expect(connections.authenticate(key)).not.toBeNull();
  });
});

describe("who sees connections", () => {
  it("refuses a customer the list and the activity", () => {
    const { connections } = service();
    const { connection } = connections.create(
      { name: "Helper", scopes: ["read_tickets"] },
      adminActor,
    );
    expect(refusal(() => connections.list(customerOne)).status).toBe(403);
    expect(refusal(() => connections.activity(connection.id, customerOne)).status).toBe(403);
    expect(connections.activity(connection.id, teamActor).connection.id).toBe(connection.id);
  });

  it("lets only an admin revoke", () => {
    const { connections } = service();
    const { connection } = connections.create(
      { name: "Helper", scopes: ["read_tickets"] },
      adminActor,
    );
    expect(refusal(() => connections.revoke(connection.id, teamActor)).status).toBe(403);
    expect(connections.revoke(connection.id, adminActor).revoked_at).not.toBeNull();
  });
});

describe("the demo's own connection page when the demo is off", () => {
  it("is not there, for opening or for asking", async () => {
    const { app } = buildTestApp();
    expect((await visitor(app).get("/demo/connection")).status).toBe(404);
    expect((await visitor(app).post("/demo/connection")).status).toBe(404);
  });
});

describe("an assistant whose connection names no scopes", () => {
  it("may do nothing, even reading", () => {
    const assistant: Actor = { id: "connection-1", kind: "agent", role: "team", name: "Helper" };
    const ticket: TicketFacts = { created_by: "dev-customer-1", archived_at: null };
    expect(can(assistant, "read", ticket)).toBe(false);
    expect(can({ ...assistant, scopes: ["read_tickets"] }, "read", ticket)).toBe(true);
  });
});

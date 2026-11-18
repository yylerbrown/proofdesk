import { describe, expect, it } from "vitest";
import type { Actor } from "../src/server/actor.js";
import { AGENT_SCOPES, CAPABILITIES, can, type Action } from "../src/server/permissions.js";

// Generated from the capability table: every action, for an agent holding every scope, holding
// only the scope the action needs, and holding none.

const ticket = { created_by: "dev-customer-1", archived_at: null };
const agent = (scopes: Actor["scopes"]): Actor => ({
  id: "conn-1",
  kind: "agent",
  role: "team",
  name: "Test agent",
  scopes,
});
const actions = Object.keys(CAPABILITIES) as Action[];
const peopleOnly = actions.filter((action) => CAPABILITIES[action].agent === "people_only");
const scoped = actions.filter((action) => CAPABILITIES[action].agent !== "people_only");

describe("the capability table", () => {
  it("keeps the customer's answer, ownership, asking, archive, restore and delete for people", () => {
    for (const action of [
      "answer",
      "take",
      "release",
      "mark_ready",
      "archive",
      "restore",
      "delete",
    ]) {
      expect(peopleOnly).toContain(action);
    }
  });

  it.each(peopleOnly)("refuses %s to an agent, even one holding every scope", (action) => {
    expect(can(agent([...AGENT_SCOPES]), action, ticket)).toBe(false);
  });

  it.each(scoped)("allows %s to an agent with exactly its scope, and not without it", (action) => {
    const needs = CAPABILITIES[action].agent as (typeof AGENT_SCOPES)[number];
    expect(can(agent([needs]), action, ticket)).toBe(true);
    expect(can(agent([]), action, ticket)).toBe(false);
    expect(can(agent(AGENT_SCOPES.filter((scope) => scope !== needs)), action, ticket)).toBe(false);
  });

  it("names a scope that exists for every action an agent may take", () => {
    for (const action of scoped) {
      expect(AGENT_SCOPES).toContain(CAPABILITIES[action].agent);
    }
  });
});

describe("the API's action table", () => {
  it("names a permission from the capability table on every route", async () => {
    const { ACTIONS } = await import("../src/server/api/actions.js");
    for (const row of ACTIONS) {
      for (const needed of [row.needs].flat()) expect(Object.keys(CAPABILITIES)).toContain(needed);
    }
  });

  it("has exactly one route for each method and address", async () => {
    const { ACTIONS } = await import("../src/server/api/actions.js");
    const routes = ACTIONS.map((row) => `${row.method} ${row.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

import type { Express } from "express";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { insertConnection } from "../src/server/connections/repository.js";
import { seedDemo } from "../src/server/demo.js";
import { can, type Action } from "../src/server/permissions.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// The demo's read-only admin sees everything an admin sees and changes nothing. That includes
// the Connections page and each connection's activity: they open as they do for the team, with
// no way to issue or revoke a connection.

/** The demo, with one connection an admin issued, as the list shows it. */
function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  insertConnection(built.db, {
    name: "Team assistant",
    keyPrefix: "abcd1234",
    keyHash: "not-a-real-key",
    scopes: ["read_tickets"],
    issuedBy: "someone",
    demo: false,
    now: "2026-11-20T00:00:00.000Z",
    expiresAt: null,
  });
  return built;
}
const asDemo = (app: Express, id: string) =>
  visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`).set("Sec-Fetch-Site", "same-origin");

const [demoCustomer, demoTeam, demoAdmin] = DEMO_ACTORS;

describe("the read-only admin and Connections", () => {
  // [who, action, expected]
  const table: [string, (typeof DEMO_ACTORS)[number], Action, boolean][] = [
    ["the demo customer does not see connections", demoCustomer!, "read_activity", false],
    ["the demo team member sees connections", demoTeam!, "read_activity", true],
    ["the read-only admin sees connections", demoAdmin!, "read_activity", true],
    ["the read-only admin issues none", demoAdmin!, "manage_connections", false],
  ];
  it.each(table)("%s", (_name, actor, action, expected) => {
    expect(can(actor, action)).toBe(expected);
  });

  it.each([
    ["demo-customer", 403],
    ["demo-team", 200],
    ["demo-admin", 200],
  ])("opens the Connections page as %s with %i", async (id, status) => {
    const { app } = buildDemo();
    expect((await asDemo(app, id).get("/connections")).status).toBe(status);
  });

  it("shows the read-only admin the list and each connection, with no form and no Revoke", async () => {
    const { app } = buildDemo();
    const page = parse((await asDemo(app, "demo-admin").get("/connections")).text);
    expect(page.querySelector('form[action="/connections"]')).toBeNull();
    expect(page.querySelectorAll("button.danger")).toHaveLength(0);
    const links = page
      .querySelectorAll("table.connections a")
      .map((link) => link.getAttribute("href")!);
    expect(links).toHaveLength(1);
    for (const link of links) expect((await asDemo(app, "demo-admin").get(link)).status).toBe(200);
  });

  it("still refuses the read-only admin issuing or revoking, and writes nothing", async () => {
    const { app, db } = buildDemo();
    const count = () =>
      db.prepare("SELECT COUNT(*) AS n, COUNT(revoked_at) AS r FROM agent_connections").get();
    const before = count();
    const issued = await asDemo(app, "demo-admin")
      .post("/connections")
      .type("form")
      .send({ name: "Mine", scopes: ["read_tickets"] });
    expect(issued.status).toBe(403);
    const id = (
      db.prepare("SELECT id FROM agent_connections WHERE demo = 0").get() as { id: number }
    ).id;
    const revoked = await asDemo(app, "demo-admin").post(`/connections/${id}/revoke`);
    expect(revoked.status).toBe(403);
    expect(count()).toEqual(before);
  });
});

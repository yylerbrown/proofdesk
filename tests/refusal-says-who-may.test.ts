import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { DEMO_KEEPS_SAMPLE, forbidden, READ_ONLY_REFUSAL } from "../src/server/errors.js";
import { CAPABILITIES, type Action } from "../src/server/permissions.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  FROM_THIS_SITE,
  handToAgent,
  teamActor,
  visitor,
} from "./helpers.js";

// A refusal says who may do the action, in the words of the table the page Who may do what
// shows, and points to that page. It says who may only when the role is the reason: the demo's
// read-only admin, anyone on the demo who tries to archive, restore or delete, and an assistant
// each get their own refusal.

const filed = {
  title: "The export button downloads an empty file",
  description: "Every export since Monday is empty.",
  fix_check: "An export of last week has rows in it.",
};

describe("a refusal that says who may", () => {
  it("names who may from the table, for every action", () => {
    for (const action of Object.keys(CAPABILITIES) as Action[]) {
      const refusal = forbidden({}, action);
      expect(refusal.status).toBe(403);
      expect(refusal.message).toBe(
        `You are not allowed to do that. Who may: ${CAPABILITIES[action].people} See who may do what at /roles.`,
      );
    }
  });

  it("keeps the read-only preview's own words", () => {
    expect(forbidden({ readOnly: true }, "delete").message).toBe(READ_ONLY_REFUSAL);
  });

  it("tells a customer in the API who may write an internal note", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: "Hello" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(
      "You are not allowed to do that. Who may: The team. See who may do what at /roles.",
    );
  });

  it("links to Who may do what on the page that refuses a delete", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const res = await as(app, teamActor).get("/tickets/SUP-1/delete");
    expect(res.status).toBe(403);
    const main = parse(res.text).querySelector("main")!;
    expect(main.text).toContain("You are not allowed to do that. Who may: An admin.");
    expect(main.text).not.toContain("/roles.");
    const link = main.querySelectorAll("a").find((a) => a.getAttribute("href") === "/roles");
    expect(link?.text).toBe("who may do what");
  });

  it("tells a team member on People what their role is", async () => {
    const { app } = buildTestApp();
    const res = await as(app, teamActor).get("/people");
    expect(res.status).toBe(403);
    expect(parse(res.text).querySelector("main")!.text).toContain(
      "Only an admin chooses who is on the team. You are a team member.",
    );
  });

  it("shows the link at the top of the ticket page after a refused form", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const browser = as(app, teamActor);
    const res = await browser.post("/tickets/SUP-1/delete").type("form").send({ confirm: "SUP-1" });
    expect(res.status).toBe(303);
    const alert = parse((await browser.get("/tickets/SUP-1")).text).querySelector(
      'p[role="alert"].refused',
    )!;
    expect(alert.text).toBe(
      "You are not allowed to do that. Who may: An admin. See who may do what.",
    );
    expect(alert.querySelector("a")?.getAttribute("href")).toBe("/roles");
  });
});

const [demoCustomer, demoTeam] = DEMO_ACTORS as [
  (typeof DEMO_ACTORS)[number],
  (typeof DEMO_ACTORS)[number],
];

/** A demo server with its sample data, as it starts. */
function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

function asDemo(app: ReturnType<typeof buildDemo>["app"], id: string) {
  return visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);
}

describe("a refusal whose reason is not the role", () => {
  it("tells anyone on the demo that the demo never archives, restores or deletes", () => {
    for (const action of ["archive", "restore", "delete"] as const) {
      expect(forbidden({ demo: true }, action).message).toBe(DEMO_KEEPS_SAMPLE);
    }
  });

  it("does not tell a demo team member that the team may archive", async () => {
    const { app } = buildDemo();
    const page = await asDemo(app, demoTeam.id).get("/tickets/SUP-3/archive");
    expect(page.status).toBe(403);
    const main = parse(page.text).querySelector("main")!;
    expect(main.text).toContain(DEMO_KEEPS_SAMPLE);
    expect(main.text).not.toContain("Who may");
    const api = await asDemo(app, demoTeam.id)
      .post("/api/tickets/SUP-3/restore")
      .set(FROM_THIS_SITE);
    expect(api.status).toBe(403);
    expect(api.body.error.message).toBe(DEMO_KEEPS_SAMPLE);
    expect(api.body.error.hint).not.toContain("Your role");
  });

  it("does not tell a demo customer that the customer who filed it may archive", async () => {
    const { app } = buildDemo();
    const page = await asDemo(app, demoCustomer.id).get("/tickets/SUP-2/archive");
    expect(page.status).toBe(403);
    expect(parse(page.text).querySelector("main")!.text).not.toContain("Who may");
  });

  it("tells an assistant the scope its connection lacks, not who on the team may", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(filed);
    const created = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Reader", scopes: "read_tickets" });
    const key = /pd_[A-Za-z0-9_-]+/.exec(created.text)![0];
    await handToAgent(app, "SUP-1", key);
    const res = await visitor(app)
      .post("/api/tickets/SUP-1/notes")
      .set("Authorization", `Bearer ${key}`)
      .send({ body: "Hello" });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(
      "You are not allowed to do that. This connection needs the write_notes scope.",
    );
  });

  it("tells an assistant that only a person may do a people-only action", () => {
    const agent = { kind: "agent" as const, scopes: ["read_tickets" as const] };
    expect(forbidden(agent, "delete").message).toBe(
      "You are not allowed to do that. Only a person may do this.",
    );
    expect(forbidden({ ...agent, scopes: ["write_notes"] }, "note").message).toBe(
      "You are not allowed to do that.",
    );
  });
});

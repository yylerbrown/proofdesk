import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { loadConfig } from "../src/server/config.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, SIGN_IN_ENV, visitor } from "./helpers.js";

const [demoCustomer, demoTeam, demoAdmin] = DEMO_ACTORS as [
  (typeof DEMO_ACTORS)[number],
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

describe("the fence around the demo", () => {
  it("never runs with real sign-in, so it can never hold a real account", () => {
    expect(() => loadConfig({ ...SIGN_IN_ENV, DEMO: "on" })).toThrow(
      /DEMO must not be on together with the GitHub sign-in settings/,
    );
  });

  it("is not combined with the development entrance", () => {
    expect(() => loadConfig({ DEMO: "on", DEV_SIGN_IN: "on" })).toThrow(/not both/);
  });

  it("may run in production without sign-in settings; nothing else may", () => {
    expect(loadConfig({ NODE_ENV: "production", DEMO: "on" }).demo).toBe(true);
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/sign-in is required/);
  });

  it("does not accept a demo person on a server that is not the demo", async () => {
    const { app } = buildTestApp();
    const res = await asDemo(app, demoAdmin.id).get("/api/tickets");
    expect(res.status).toBe(401);
  });
});

describe("the demo entrance", () => {
  it("says it is a demo, offers the three demo people and no one else", async () => {
    const { app } = buildDemo();
    const about = await visitor(app).get("/sign-in");
    expect(about.text).toContain("About this demo");
    expect(about.text).toContain("Do not type anything private here.");
    // A first visit opens as the demo customer, and the role menu names the other two. The
    // admin is named for what it is before anyone picks it: it changes nothing.
    const page = await visitor(app).get("/tickets");
    expect(page.text).toContain("Demo Customer (you)");
    expect(page.text).toContain("Demo Team Member");
    expect(page.text).toContain("Demo Admin (read-only)");
    for (const shown of [about, page]) {
      expect(shown.text).not.toContain("Customer One");
      expect(shown.text).not.toContain("Sign in with GitHub");
    }

    const signedIn = await visitor(app).post("/sign-in/dev").type("form").send({ id: demoTeam.id });
    expect(signedIn.status).toBe(303);
    // A development person is refused here.
    const dev = await visitor(app).post("/sign-in/dev").type("form").send({ id: "dev-admin-1" });
    expect(dev.status).toBe(400);
  });

  it("shows the demo banner on every page", async () => {
    const { app } = buildDemo();
    for (const address of ["/sign-in", "/tickets", "/tickets/SUP-1"]) {
      const res = await asDemo(app, demoTeam.id).get(address);
      expect(res.text, address).toContain("Demo: sample data, shared with every visitor.");
    }
    const normal = await visitor(buildTestApp().app).get("/sign-in");
    expect(normal.text).not.toContain("Demo: sample data");
  });
});

describe("the sample data", () => {
  it("counts archived tickets, so it never seeds a second set", () => {
    const { db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(db, "SUP");
    seedDemo(service);
    const seeded = service.listTickets("all", adminActor);
    // Every sample archived, as an admin outside the demo rules could.
    for (const ticket of seeded) service.archiveTicket(ticket.key, adminActor);
    seedDemo(service);
    const count = db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number };
    expect(count.n).toBe(seeded.length);
  });

  it("is made through the service, with a real history", async () => {
    const { app } = buildDemo();
    const list = await asDemo(app, demoTeam.id).get("/api/tickets");
    // Open tickets newest first, the New ones that say how to verify ahead of the others, then
    // the resolved one. The two samples for AI assistants were filed first, so they are the
    // oldest and sit under the plain support samples.
    expect(list.body.map((t: { key: string }) => t.key)).toEqual([
      "SUP-8",
      "SUP-5",
      "SUP-4",
      "SUP-7",
      "SUP-3",
      "SUP-2",
      "SUP-1",
      "SUP-6",
    ]);
    const sample = list.body.find((t: { key: string }) => t.key === "SUP-1");
    const recorded = list.body.find((t: { key: string }) => t.key === "SUP-2");
    expect(sample.title).toBe("Sample for your AI assistant: the total adds tax twice");
    expect(recorded.title).toBe("The checkout total adds tax twice");
    // Every status is there, so each filter changes the list.
    const statuses = new Set(list.body.map((t: { status: string }) => t.status));
    expect([...statuses].sort()).toEqual(["in_progress", "new", "resolved"]);
    const first = await asDemo(app, demoTeam.id).get("/api/tickets/SUP-3");
    expect(first.body).toMatchObject({ status: "in_progress", owner_name: "Demo Team Member" });
    const history = await asDemo(app, demoTeam.id).get("/api/tickets/SUP-3/events");
    expect(history.body.map((e: { type: string }) => e.type)).toContain("owner_changed");
  });

  it("is added only to an empty database", () => {
    const { db, config } = buildDemo();
    const service = createTicketService(db, config.ticketPrefix);
    seedDemo(service);
    expect(service.listTickets("all", demoAdmin)).toHaveLength(8);
  });
});

describe("the demo admin sees everything and changes nothing", () => {
  it("sees archived tickets and internal notes", async () => {
    const { app } = buildDemo();
    const admin = asDemo(app, demoAdmin.id);
    expect((await admin.get("/api/tickets?status=archived")).status).toBe(200);
    const entries = await admin.get("/api/tickets/SUP-3/entries");
    expect(entries.body.map((e: { kind: string }) => e.kind)).toContain("note");
  });

  it.each([
    ["post", "/api/tickets", { title: "Spam ticket", description: "x" }],
    ["put", "/api/tickets/SUP-3", { title: "Changed", description: "x" }],
    ["patch", "/api/tickets/SUP-3", { status: "new" }],
    ["post", "/api/tickets/SUP-3/archive", {}],
    ["post", "/api/tickets/SUP-5/restore", {}],
    ["delete", "/api/tickets/SUP-3", { confirm: "SUP-3" }],
    ["post", "/api/tickets/SUP-3/take", {}],
    ["post", "/api/tickets/SUP-3/entries", { kind: "note", body: "x" }],
    ["put", "/api/tickets/SUP-3/agreed-check", { agreed_check: "x" }],
  ] as const)("is refused: %s %s", async (method, address, body) => {
    const { app } = buildDemo();
    const before = await asDemo(app, demoTeam.id).get("/api/tickets/SUP-3");
    const res = await asDemo(app, demoAdmin.id)[method](address).send(body);
    expect(res.status).toBe(403);
    expect((await asDemo(app, demoTeam.id).get("/api/tickets/SUP-3")).body).toEqual(before.body);
  });

  it("is shown no controls that would change anything", async () => {
    const { app } = buildDemo();
    const page = await asDemo(app, demoAdmin.id).get("/tickets/SUP-3");
    // The ticket itself is shown, so the missing controls are not an error page's.
    expect(page.status).toBe(200);
    expect(page.text).toContain("Cannot sign in on my phone");
    for (const action of ["/edit", "/archive", "/delete", "/take", "/entries", "/status"]) {
      expect(page.text, action).not.toContain(`/tickets/SUP-3${action}`);
    }
  });
});

describe("the other demo people", () => {
  it("cannot archive, restore or delete, so one visitor cannot empty the demo", async () => {
    const { app } = buildDemo();
    const team = asDemo(app, demoTeam.id);
    expect((await team.post("/api/tickets/SUP-3/archive")).status).toBe(403);
    expect((await team.delete("/api/tickets/SUP-3").send({ confirm: "SUP-3" })).status).toBe(403);
    const mine = await asDemo(app, demoCustomer.id).post("/api/tickets/SUP-3/archive");
    expect(mine.status).toBe(403);
    expect((await team.get("/api/tickets")).body).toHaveLength(8);
    expect((await team.get("/tickets/SUP-3")).text).not.toContain("/tickets/SUP-3/archive");
  });

  it("let a visitor file a ticket and reply as a customer, and work on it as the team", async () => {
    const { app } = buildDemo();
    const filed = await asDemo(app, demoCustomer.id)
      .post("/api/tickets")
      .send({ title: "Trying the demo", description: "Hello" });
    expect(filed.status).toBe(201);
    const taken = await asDemo(app, demoTeam.id).post(`/api/tickets/${filed.body.key}/take`);
    expect(taken.status).toBe(200);
  });
});

describe("a demo server started in production", () => {
  it("marks the demo identity cookie Secure", async () => {
    const built = buildTestApp({ NODE_ENV: "production", DEMO: "on", ...noSignIn() });
    const res = await visitor(built.app)
      .post("/sign-in/dev")
      .type("form")
      .send({ id: demoTeam.id });
    expect(res.status).toBe(303);
    expect(String(res.headers["set-cookie"])).toContain("Secure");
  });

  it("serves its pages without any sign-in settings", async () => {
    const built = buildTestApp({ NODE_ENV: "production", DEMO: "on", ...noSignIn() });
    const res = await request(built.app).get("/sign-in");
    expect(res.status).toBe(200);
    expect(res.text).toContain("About this demo");
    // The first visit opens the list, with the demo's cookie sent over https only.
    const landed = await request(built.app).get("/tickets");
    expect(landed.status).toBe(200);
    expect(String(landed.headers["set-cookie"])).toMatch(/dev_actor=demo-customer;.*Secure/);
  });
});

/** Blank values for the sign-in settings, which the production test helper fills in. */
function noSignIn() {
  return {
    BETTER_AUTH_SECRET: "",
    BETTER_AUTH_URL: "",
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
  };
}

describe("the read-only admin preview's header", () => {
  it("offers no New ticket, which the preview could not file, while the team still has it", async () => {
    const { app } = buildDemo();
    const header = async (id: string) =>
      (await asDemo(app, id).get("/tickets")).text.split("</header>")[0]!;
    expect(await header(demoAdmin.id)).not.toContain('href="/tickets/new"');
    expect(await header(demoTeam.id)).toContain('href="/tickets/new"');
    expect(
      (
        await asDemo(app, demoAdmin.id)
          .post("/tickets")
          .type("form")
          .send({ title: "Test", description: "x" })
      ).status,
    ).toBe(403);
  });
});

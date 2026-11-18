import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { WRITE_LIMIT } from "../src/server/limits.js";
import {
  createTicketService,
  DEMO_BUDGET,
  LIST_PAGE_SIZE,
  THREAD_LIMIT,
} from "../src/server/tickets/service.js";
import { admin, adminActor, buildTestApp, visitor } from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams." };
const demoTeam = DEMO_ACTORS[1]!;

describe("one write allowance for every route that changes something", () => {
  it("is shared by the pages and the API", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    // Half through the API, half through the page form.
    for (let i = 0; i < WRITE_LIMIT; i++) {
      const res =
        i % 2 === 0
          ? await admin(app)
              .post("/api/tickets/SUP-1/entries")
              .send({ kind: "note", body: `n${i}` })
          : await admin(app)
              .post("/tickets/SUP-1/entries")
              .type("form")
              .send({ kind: "note", body: `n${i}` });
      if (res.status === 429) break;
    }
    const api = await admin(app)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: "x" });
    expect(api.status).toBe(429);
    const form = await admin(app).post("/tickets/SUP-1/edit").type("form").send(valid);
    expect(form.status).toBe(429);
    // Reading is not counted.
    expect((await admin(app).get("/api/tickets/SUP-1")).status).toBe(200);
  });

  it("gives each demo visitor their own allowance, though they share a demo identity", async () => {
    const { app } = buildTestApp({
      DEMO: "on",
      DEV_SIGN_IN: "off",
      CLIENT_IP_HEADER: "fly-client-ip",
    });
    const as = (address: string) =>
      visitor(app).set("fly-client-ip", address).set("Cookie", `${DEV_COOKIE}=${demoTeam.id}`);
    await as("203.0.113.1").post("/api/tickets").send(valid);
    // Refused requests count too, and these write no rows, so the demo budget stays clear.
    for (let i = 0; i < WRITE_LIMIT; i++) {
      await as("203.0.113.1").post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "" });
    }
    expect((await as("203.0.113.1").post("/api/tickets/SUP-1/take")).status).toBe(429);
    expect((await as("198.51.100.7").post("/api/tickets/SUP-1/take")).status).toBe(200);
  });
});

describe("the demo's budget of rows", () => {
  function demoService() {
    const { db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    return { db, service: createTicketService(db, "SUP", DEMO_BUDGET) };
  }
  const count = (db: ReturnType<typeof demoService>["db"], table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it("refuses a ticket past the budget and adds no row", () => {
    const { db, service } = demoService();
    for (let i = 0; i < DEMO_BUDGET.tickets!; i++) service.createTicket(valid, demoTeam);
    expect(() => service.createTicket(valid, demoTeam)).toThrow(/holds no more tickets/);
    expect(count(db, "tickets")).toBe(DEMO_BUDGET.tickets);
  });

  it("refuses a reply past the budget and adds no row", () => {
    const { db, service } = demoService();
    service.createTicket(valid, demoTeam);
    for (let i = 0; i < DEMO_BUDGET.entriesPerTicket!; i++) {
      service.addEntry("SUP-1", { kind: "reply", body: `r${i}` }, demoTeam);
    }
    const events = count(db, "ticket_events");
    expect(() => service.addEntry("SUP-1", { kind: "reply", body: "one more" }, demoTeam)).toThrow(
      /holds no more replies/,
    );
    expect(count(db, "ticket_entries")).toBe(DEMO_BUDGET.entriesPerTicket);
    expect(count(db, "ticket_events")).toBe(events);
  });

  it("refuses a change past the history budget and leaves the ticket as it was", () => {
    const { db, service } = demoService();
    service.createTicket(valid, demoTeam);
    // Alternating the description keeps both versions in the history each time.
    for (let i = 1; i < DEMO_BUDGET.eventsPerTicket!; i++) {
      service.editTicket(
        "SUP-1",
        { ...valid, description: i % 2 ? "Version B" : "It jams." },
        demoTeam,
      );
    }
    const before = service.getTicket("SUP-1", demoTeam);
    expect(() =>
      service.editTicket("SUP-1", { ...valid, description: "One too many" }, demoTeam),
    ).toThrow(/holds no more changes/);
    expect(service.getTicket("SUP-1", demoTeam)).toEqual(before);
    expect(count(db, "ticket_events")).toBe(DEMO_BUDGET.eventsPerTicket);
  });

  it("does not apply to real tickets", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(valid, adminActor);
    for (let i = 0; i <= DEMO_BUDGET.entriesPerTicket!; i++) {
      service.addEntry("SUP-1", { kind: "note", body: `n${i}` }, adminActor);
    }
    expect(count(db, "ticket_entries")).toBe(DEMO_BUDGET.entriesPerTicket! + 1);
  });

  it("answers 409 through the API when full", async () => {
    const { app, db } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(db, "SUP", DEMO_BUDGET);
    for (let i = 0; i < DEMO_BUDGET.tickets!; i++) service.createTicket(valid, demoTeam);
    const res = await visitor(app)
      .set("Cookie", `${DEV_COOKIE}=${demoTeam.id}`)
      .post("/api/tickets")
      .send(valid);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("budget_full");
  });
});

describe("reads come in bounded pages", () => {
  it("lists at most one page of tickets, with the next page on request", async () => {
    const { app, db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    for (let i = 0; i < LIST_PAGE_SIZE + 1; i++) service.createTicket(valid, adminActor);
    const first = await admin(app).get("/api/tickets");
    expect(first.body).toHaveLength(LIST_PAGE_SIZE);
    expect(first.body[0].key).toBe(`SUP-${LIST_PAGE_SIZE + 1}`);
    const second = await admin(app).get("/api/tickets?page=2");
    expect(second.body.map((t: { key: string }) => t.key)).toEqual(["SUP-1"]);
    const page = await admin(app).get("/tickets");
    expect(page.text).toContain('href="/tickets?page=2"');
    // The next page keeps the filters, on the API and on the page.
    const narrowed = await admin(app).get("/api/tickets?owner=none&q=printer");
    expect(narrowed.headers.link).toMatch(
      /^<\/api\/tickets\?owner=none&q=printer&cursor=[^>]+>; rel="next"$/,
    );
    const filteredPage = await admin(app).get("/tickets?owner=none");
    expect(filteredPage.text).toContain('href="/tickets?owner=none&amp;page=2"');
  });

  it("shows at most the latest entries and history of one ticket, oldest first", () => {
    const { db } = buildTestApp();
    const service = createTicketService(db, "SUP");
    service.createTicket(valid, adminActor);
    for (let i = 0; i < THREAD_LIMIT + 5; i++) {
      service.addEntry("SUP-1", { kind: "note", body: `n${i}` }, adminActor);
    }
    const entries = service.listEntries("SUP-1", adminActor);
    expect(entries).toHaveLength(THREAD_LIMIT);
    expect(entries.at(-1)!.body).toBe(`n${THREAD_LIMIT + 4}`);
    expect(entries[0]!.body).toBe("n5");
    expect(service.listEvents("SUP-1", adminActor)).toHaveLength(THREAD_LIMIT);
  });
});

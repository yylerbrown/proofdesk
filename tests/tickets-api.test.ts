import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

const valid = { title: "Printer is broken", description: "It jams on every page." };

describe("POST /api/tickets validation", () => {
  const cases: [string, unknown, boolean][] = [
    // [name, body, accepted]
    ["minimal valid body", valid, true],
    ["title of 3 characters", { ...valid, title: "abc" }, true],
    ["title of 120 characters", { ...valid, title: "a".repeat(120) }, true],
    ["title of 2 characters", { ...valid, title: "ab" }, false],
    ["title of 121 characters", { ...valid, title: "a".repeat(121) }, false],
    ["title that is short once trimmed", { ...valid, title: "  ab  " }, false],
    ["missing title", { description: valid.description }, false],
    ["title that is not a string", { ...valid, title: 12345 }, false],
    ["description of 1 character", { ...valid, description: "x" }, true],
    ["description of 5000 characters", { ...valid, description: "a".repeat(5000) }, true],
    ["description of 5001 characters", { ...valid, description: "a".repeat(5001) }, false],
    ["blank description", { ...valid, description: "   " }, false],
    ["missing description", { title: valid.title }, false],
    ["https where_url", { ...valid, where_url: "https://example.com/page?x=1" }, true],
    ["http where_url", { ...valid, where_url: "http://example.com" }, true],
    [
      "where_url of 500 characters",
      { ...valid, where_url: "https://example.com/" + "a".repeat(480) },
      true,
    ],
    [
      "where_url of 501 characters",
      { ...valid, where_url: "https://example.com/" + "a".repeat(481) },
      false,
    ],
    ["where_url that is not a URL", { ...valid, where_url: "not a url" }, false],
    ["where_url with an ftp scheme", { ...valid, where_url: "ftp://example.com/file" }, false],
    ["where_url with a javascript scheme", { ...valid, where_url: "javascript:alert(1)" }, false],
    ["empty where_url", { ...valid, where_url: "" }, false],
    ["fix_check of 500 characters", { ...valid, fix_check: "a".repeat(500) }, true],
    ["fix_check of 501 characters", { ...valid, fix_check: "a".repeat(501) }, false],
    ["empty body object", {}, false],
  ];

  it.each(cases)("%s", async (_name, body, accepted) => {
    const { app } = buildTestApp();
    const res = await request(app)
      .post("/api/tickets")
      .send(body as object);
    if (accepted) {
      expect(res.status).toBe(201);
    } else {
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(typeof res.body.error.message).toBe("string");
    }
  });

  it("rejects a request with no body", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/tickets");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("create and get", () => {
  it("creates a ticket and returns it with a key", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/tickets").send({
      title: "  Cannot log in  ",
      description: "The page says my password is wrong.",
      where_url: "https://example.com/login",
      fix_check: "I can open my account page.",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      key: "SUP-1",
      title: "Cannot log in",
      description: "The page says my password is wrong.",
      status: "new",
      where_url: "https://example.com/login",
      fix_check: "I can open my account page.",
      created_by: null,
      owner_id: null,
      agent_id: null,
      created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
      updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
    });
  });

  it("stores missing optional fields as null", async () => {
    const { app } = buildTestApp();
    const res = await request(app).post("/api/tickets").send(valid);
    expect(res.body.where_url).toBeNull();
    expect(res.body.fix_check).toBeNull();
  });

  it("gets the same ticket back by key", async () => {
    const { app } = buildTestApp();
    const created = await request(app).post("/api/tickets").send(valid);
    const res = await request(app).get(`/api/tickets/${created.body.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
  });

  it("uses the configured prefix", async () => {
    const { app } = buildTestApp({ TICKET_PREFIX: "HELP" });
    const created = await request(app).post("/api/tickets").send(valid);
    expect(created.body.key).toBe("HELP-1");
    expect((await request(app).get("/api/tickets/HELP-1")).status).toBe(200);
    expect((await request(app).get("/api/tickets/SUP-1")).status).toBe(400);
  });

  it("returns 404 for a well-formed key that does not exist", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/tickets/SUP-999");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ticket_not_found");
  });

  it.each(["1", "SUP-abc", "SUP-0", "ABC-1", "sup-1"])(
    "returns 400 for the malformed key %s",
    async (key) => {
      const { app } = buildTestApp();
      const res = await request(app).get(`/api/tickets/${key}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_key");
    },
  );
});

describe("GET /api/tickets", () => {
  async function makeTickets() {
    const { app } = buildTestApp();
    for (const title of ["First", "Second", "Third"]) {
      await request(app).post("/api/tickets").send({ title, description: "d" });
    }
    await request(app).patch("/api/tickets/SUP-2").send({ status: "in_progress" });
    await request(app).patch("/api/tickets/SUP-3").send({ status: "resolved" });
    return app;
  }

  it("lists newest first", async () => {
    const { app } = buildTestApp();
    for (const title of ["First", "Second", "Third"]) {
      await request(app).post("/api/tickets").send({ title, description: "d" });
    }
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body.map((t: { key: string }) => t.key)).toEqual(["SUP-3", "SUP-2", "SUP-1"]);
  });

  it("returns an empty list when there are no tickets", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/tickets");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it.each([
    ["new", ["SUP-1"]],
    ["in_progress", ["SUP-2"]],
    ["resolved", ["SUP-3"]],
    ["all", ["SUP-3", "SUP-2", "SUP-1"]],
  ])("filters by status=%s", async (status, expectedKeys) => {
    const app = await makeTickets();
    const res = await request(app).get("/api/tickets").query({ status });
    expect(res.status).toBe(200);
    expect(res.body.map((t: { key: string }) => t.key)).toEqual(expectedKeys);
  });

  it.each(["done", "NEW", "", "new,resolved"])("returns 400 for status=%j", async (status) => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/tickets").query({ status });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });
});

describe("PATCH /api/tickets/:key", () => {
  it("changes the status and writes exactly one event with the old and new status", async () => {
    const { app, db } = buildTestApp();
    await request(app).post("/api/tickets").send(valid);
    const before = db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get();
    expect(before).toEqual({ n: 1 }); // the "created" event

    const res = await request(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");

    const events = db
      .prepare("SELECT actor, type, data FROM ticket_events WHERE type = 'status_changed'")
      .all();
    expect(events).toEqual([
      {
        actor: "anonymous",
        type: "status_changed",
        data: JSON.stringify({ from: "new", to: "in_progress" }),
      },
    ]);
  });

  it("writes no event and keeps updated_at when the status does not change", async () => {
    const { app, db } = buildTestApp();
    const created = await request(app).post("/api/tickets").send(valid);
    const res = await request(app).patch("/api/tickets/SUP-1").send({ status: "new" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 1 });
  });

  it("returns 404 for an unknown key", async () => {
    const { app } = buildTestApp();
    const res = await request(app).patch("/api/tickets/SUP-5").send({ status: "resolved" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("ticket_not_found");
  });

  it("returns 400 for a malformed key", async () => {
    const { app } = buildTestApp();
    const res = await request(app).patch("/api/tickets/nope").send({ status: "resolved" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_key");
  });

  it.each([{ status: "done" }, { status: 1 }, {}, { status: "all" }])(
    "returns 400 for the body %j",
    async (body) => {
      const { app } = buildTestApp();
      await request(app).post("/api/tickets").send(valid);
      const res = await request(app).patch("/api/tickets/SUP-1").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    },
  );
});

describe("GET /api/tickets/:key/events", () => {
  it("returns creation then status change, oldest first", async () => {
    const { app } = buildTestApp();
    await request(app).post("/api/tickets").send(valid);
    await request(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    await request(app).patch("/api/tickets/SUP-1").send({ status: "resolved" });

    const res = await request(app).get("/api/tickets/SUP-1/events");
    expect(res.status).toBe(200);
    expect(res.body.map((e: { type: string; data: unknown }) => [e.type, e.data])).toEqual([
      ["created", { status: "new" }],
      ["status_changed", { from: "new", to: "in_progress" }],
      ["status_changed", { from: "in_progress", to: "resolved" }],
    ]);
    expect(res.body[0]).toMatchObject({ ticket_key: "SUP-1", actor: "anonymous" });
  });

  it("returns only the events of the ticket that was asked for", async () => {
    const { app } = buildTestApp();
    await request(app).post("/api/tickets").send(valid);
    await request(app).post("/api/tickets").send(valid);
    await request(app).patch("/api/tickets/SUP-1").send({ status: "in_progress" });
    await request(app).patch("/api/tickets/SUP-2").send({ status: "resolved" });
    await request(app).patch("/api/tickets/SUP-2").send({ status: "new" });

    type Row = { ticket_key: string; type: string; data: unknown };
    const summary = (rows: Row[]) => rows.map((e) => [e.ticket_key, e.type, e.data]);

    const first = await request(app).get("/api/tickets/SUP-1/events");
    expect(summary(first.body)).toEqual([
      ["SUP-1", "created", { status: "new" }],
      ["SUP-1", "status_changed", { from: "new", to: "in_progress" }],
    ]);

    const second = await request(app).get("/api/tickets/SUP-2/events");
    expect(summary(second.body)).toEqual([
      ["SUP-2", "created", { status: "new" }],
      ["SUP-2", "status_changed", { from: "new", to: "resolved" }],
      ["SUP-2", "status_changed", { from: "resolved", to: "new" }],
    ]);
  });

  it("says what kind of actor wrote each event", async () => {
    const { app } = buildTestApp();
    await request(app).post("/api/tickets").send(valid);
    const res = await request(app).get("/api/tickets/SUP-1/events");
    expect(res.body[0]).toMatchObject({ actor: "anonymous", actor_kind: "person" });
  });

  it("returns 404 for an unknown ticket and 400 for a malformed key", async () => {
    const { app } = buildTestApp();
    expect((await request(app).get("/api/tickets/SUP-9/events")).status).toBe(404);
    expect((await request(app).get("/api/tickets/x/events")).status).toBe(400);
  });
});

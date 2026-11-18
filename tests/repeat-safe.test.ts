import request from "supertest";
import { describe, expect, it } from "vitest";
import { LIST_PAGE_SIZE } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Writes that are safe to retry, and lists that say where their next page is.

const valid = { title: "Printer jams", description: "It jams on page two." };

describe("an idempotency key", () => {
  it("makes a retried write act once and answer the same", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const note = { kind: "note", body: "Looked at the tray." };
    const first = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .set("Idempotency-Key", "abc-1")
      .send(note);
    const again = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .set("Idempotency-Key", "abc-1")
      .send(note);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const entries = (await admin(app).get("/api/tickets/SUP-1/entries")).body;
    expect(entries.filter((e: { body: string }) => e.body === note.body)).toHaveLength(1);
  });

  it("refuses the same key for a different request, and says what to do", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const send = (body: string) =>
      as(app, teamActor)
        .post("/api/tickets/SUP-1/entries")
        .set("Idempotency-Key", "k")
        .send({ kind: "note", body });
    await send("first");
    const other = await send("second");
    expect(other.status).toBe(409);
    expect(other.body.error).toMatchObject({ code: "idempotency_key_reused", retry: false });
    expect(other.body.error.hint).toMatch(/new idempotency key/);
  });

  it("is kept for each person or connection apart", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const note = { kind: "note", body: "same words" };
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .set("Idempotency-Key", "shared")
      .send(note);
    await admin(app).post("/api/tickets/SUP-1/entries").set("Idempotency-Key", "shared").send(note);
    expect((await admin(app).get("/api/tickets/SUP-1/entries")).body).toHaveLength(2);
  });

  it("stores nothing for a refused write, so the same key can be used once it is fixed", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const empty = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .set("Idempotency-Key", "retry-me")
      .send({ kind: "note", body: "" });
    expect(empty.status).toBe(400);
    const fixed = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .set("Idempotency-Key", "retry-me")
      .send({ kind: "note", body: "Now with words" });
    expect(fixed.status).toBe(201);
  });

  it("goes with the ticket when it is deleted permanently", async () => {
    const { app, db } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await admin(app)
      .post("/api/tickets/SUP-1/entries")
      .set("Idempotency-Key", "gone")
      .send({ kind: "note", body: "secret words" });
    await admin(app).delete("/api/tickets/SUP-1").send({ confirm: "SUP-1" });
    const left = JSON.stringify(db.prepare("SELECT * FROM idempotency_keys").all());
    expect(left).not.toContain("secret words");
  });
});

describe("a list in pages", () => {
  it("says where the next page is in a Link header, and nothing on the last page", async () => {
    const { app, db } = buildTestApp();
    const insert = db.prepare(
      "INSERT INTO tickets (title, description, created_by, created_at, updated_at) VALUES ('t', 'd', 'dev-customer-1', ?, ?)",
    );
    const now = new Date().toISOString();
    for (let i = 0; i < LIST_PAGE_SIZE + 5; i++) insert.run(now, now);
    const first = await as(app, customerOne).get("/api/tickets?status=new");
    expect(first.body).toHaveLength(LIST_PAGE_SIZE);
    const link = /<([^>]+)>; rel="next"/.exec(first.headers.link ?? "")?.[1];
    expect(link).toMatch(/^\/api\/tickets\?status=new&cursor=/);
    const second = await as(app, customerOne).get(link!);
    expect(second.body).toHaveLength(5);
    expect(second.headers.link).toBeUndefined();
  });

  it("refuses a cursor that was not made here", async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .get("/api/tickets?cursor=nonsense")
      .set("Cookie", "dev_actor=dev-admin-1");
    expect(res.status).toBe(400);
    expect(res.body.error.fields.cursor).toBeDefined();
  });
});

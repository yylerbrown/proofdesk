import type { Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { admin, as, buildTestApp, customerOne, handToAgent } from "./helpers.js";

// A retry with an idempotency key gets the first answer back only while the caller may still
// read the ticket. Once its hand-off has ended, a connection's retry is answered as the same
// write without a key: the ticket is not found.

async function connection(app: Express): Promise<string> {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
  return keyOnPage(res.text);
}

describe("a keyed retry after access is lost", () => {
  it("is answered as the unkeyed write would be, not with the saved answer", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams." });
    const key = await connection(app);
    await handToAgent(app, "SUP-1", key);
    const note = () =>
      request(app)
        .post("/api/tickets/SUP-1/notes")
        .set("Authorization", `Bearer ${key}`)
        .set("Idempotency-Key", "note-1")
        .send({ body: "Looked at the driver." });
    const first = await note();
    expect(first.status).toBe(201);
    // While it may still read the ticket, the retry is the first answer again.
    const again = await note();
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);

    const ended = await admin(app).post("/tickets/SUP-1/agent/end").type("form").send({});
    expect(ended.status).toBe(303);
    const unkeyed = await request(app)
      .post("/api/tickets/SUP-1/notes")
      .set("Authorization", `Bearer ${key}`)
      .send({ body: "Looked at the driver." });
    const retry = await note();
    expect(unkeyed.status).toBe(404);
    expect(retry.status).toBe(unkeyed.status);
    expect(retry.body).toEqual(unkeyed.body);
  });
});

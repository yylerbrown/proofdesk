import request from "supertest";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// What the JSON API answers: a 401 names the scheme a program signs in with, and a reply is
// never described as a note.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

describe("a 401 from the JSON API", () => {
  it("names the Bearer scheme when nobody is signed in", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/tickets/SUP-9999");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("not_signed_in");
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("says the token is invalid when a wrong key was sent", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/tickets").set("Authorization", "Bearer nonsense");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_connection_key");
    expect(res.headers["www-authenticate"]).toBe('Bearer error="invalid_token"');
  });

  it("is not sent on other errors, and pages still go to sign-in", async () => {
    const { app } = buildTestApp();
    const missing = await as(app, customerOne).get("/api/tickets/SUP-9999");
    expect(missing.status).toBe(404);
    expect(missing.headers["www-authenticate"]).toBeUndefined();

    const page = await visitor(app).get("/tickets/SUP-1");
    expect(page.status).toBe(303);
    expect(page.headers.location).toMatch(/^\/sign-in/);
    expect(page.headers["www-authenticate"]).toBeUndefined();
  });

  it("is described with its header in the OpenAPI document", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/openapi.json");
    const answer = res.body.paths["/tickets"].get.responses["401"];
    expect(answer.headers["WWW-Authenticate"].description).toMatch(/^Bearer/);
  });
});

describe("the purpose of an entry", () => {
  it("is sent on notes only, and is null on every reply", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const team = as(app, teamActor);
    await team.post("/api/tickets/SUP-1/entries").send({ kind: "reply", body: "Which printer?" });
    await team.post("/api/tickets/SUP-1/entries").send({ kind: "note", body: "Likely the tray." });
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "The one upstairs." });

    const seen = await team.get("/api/tickets/SUP-1/entries");
    expect(seen.status).toBe(200);
    expect(seen.body.map((e: { kind: string; purpose: unknown }) => [e.kind, e.purpose])).toEqual([
      ["reply", null],
      ["note", "note"],
      ["reply", null],
    ]);

    // The customer's own view carries no purpose at all on their thread of replies.
    const customer = await as(app, customerOne).get("/api/tickets/SUP-1/entries");
    expect(customer.body.map((e: { purpose: unknown }) => e.purpose)).toEqual([null, null]);
    expect(JSON.stringify(customer.body)).not.toMatch(/note/i);
  });

  it("is described as nullable and for notes only in the OpenAPI document", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/api/openapi.json");
    const purpose = res.body.components.schemas.Entry.properties.purpose;
    expect(purpose.description).toMatch(/^Notes only:.*Null on a reply\.$/);
    expect(JSON.stringify(purpose)).toMatch(/"null"|null\]/);
  });
});

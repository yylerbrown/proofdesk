import request from "supertest";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, visitor } from "./helpers.js";

// What the JSON API answers: a 401 names the scheme a program signs in with.

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

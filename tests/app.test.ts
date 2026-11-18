import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase, type Db } from "../src/server/db.js";
import { runMigrations } from "../src/server/migrate.js";

const dbs: Db[] = [];

function build(env: NodeJS.ProcessEnv = {}) {
  const db = openDatabase(":memory:");
  dbs.push(db);
  runMigrations(db);
  return { app: createApp(loadConfig(env), db), db };
}

afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
});

describe("GET /api/health", () => {
  it("reports ok, version, commit and database state", async () => {
    const { app } = build({ GIT_COMMIT: "abc123" });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      commit: "abc123",
      database: "ok",
    });
  });

  it("reports a null commit when none is provided", async () => {
    const { app } = build();
    const res = await request(app).get("/api/health");
    expect(res.body.commit).toBeNull();
  });

  it("returns 503 when the database is unavailable", async () => {
    const { app, db } = build();
    db.close();
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.database).toBe("error");
  });
});

describe("error handling", () => {
  it("returns a JSON 404 for unknown api routes", async () => {
    const { app } = build();
    const res = await request(app).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual({
      error: { code: "not_found", message: "No route for GET /api/nope" },
    });
  });

  it("returns a JSON 400 for malformed JSON bodies", async () => {
    const { app } = build();
    const res = await request(app)
      .post("/api/health")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Content-Type", "application/json")
      .send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: { code: "bad_request", message: "The request was invalid." },
    });
  });
});

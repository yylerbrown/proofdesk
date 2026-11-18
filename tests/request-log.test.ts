import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { buildTestApp } from "./helpers.js";

// One line of JSON per request on standard output: an id, the method, the path without its
// query string, the status and the time taken. Nothing else.

/** An app on a fresh database whose log lines are kept in an array. */
function loggedApp() {
  const { db } = buildTestApp();
  const lines: string[] = [];
  const app = createApp(loadConfig({ DEV_SIGN_IN: "on" }), db, { log: (line) => lines.push(line) });
  return { app, lines };
}

/** Waits until the log line for the finished answer has been written. */
async function nextLine(lines: string[], count: number): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50 && lines.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return JSON.parse(lines[count - 1]!) as Record<string, unknown>;
}

describe("the request log", () => {
  it("writes the method, the path, the status, the time and the request id", async () => {
    const { app, lines } = loggedApp();
    const res = await request(app).get("/sign-in");
    const line = await nextLine(lines, 1);
    expect(line.method).toBe("GET");
    expect(line.path).toBe("/sign-in");
    expect(line.status).toBe(200);
    expect(typeof line.ms).toBe("number");
    expect(line.request_id).toBe(res.headers["x-request-id"]);
    expect(Object.keys(line).sort()).toEqual(
      ["at", "method", "ms", "path", "request_id", "status"].sort(),
    );
  });

  it("never holds a cookie, an authorization header or a query string", async () => {
    const { app, lines } = loggedApp();
    await request(app)
      .get("/tickets?q=private-search-words&code=one-time-code")
      .set("Cookie", `${DEV_COOKIE}=dev-admin-1; other=cookie-value`)
      .set("Authorization", "Bearer secret-key-value");
    await nextLine(lines, 1);
    const written = lines.join("\n");
    expect(written).toContain('"path":"/tickets"');
    for (const secret of [
      "private-search-words",
      "one-time-code",
      "dev-admin-1",
      "cookie-value",
      "secret-key-value",
      "Bearer",
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  it("does not log a health check that passed", async () => {
    const { app, lines } = loggedApp();
    await request(app).get("/api/health");
    await request(app).get("/sign-in");
    const line = await nextLine(lines, 1);
    expect(line.path).toBe("/sign-in");
    expect(lines).toHaveLength(1);
  });
});

describe("the request id", () => {
  it("keeps a safe id the proxy gave", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/sign-in").set("Fly-Request-Id", "01ABCDEF-proxy-id");
    expect(res.headers["x-request-id"]).toBe("01ABCDEF-proxy-id");
  });

  it("replaces an id with odd characters by a new one", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/sign-in").set("X-Request-Id", 'bad" id\\with "quotes"');
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

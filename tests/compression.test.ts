import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, buildTestApp } from "./helpers.js";

// Text answers are compressed when the browser accepts it, except the MCP endpoint and any
// answer marked no-store. Stylesheets, scripts and fonts say how long a browser may keep them.

const GZIP = { "Accept-Encoding": "gzip" };

async function issueKey(app: Express): Promise<string> {
  const res = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets"] });
  return parse(res.text).querySelector("input.key")!.getAttribute("value")!;
}

describe("compression", () => {
  it("compresses the sign-in page, which nobody is signed in to", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/sign-in").set(GZIP);
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.text).toContain("<html");
  });

  it("compresses a stylesheet", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/assets/pico.min.css").set(GZIP);
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("leaves a no-store page alone", async () => {
    const { app } = buildTestApp();
    const res = await admin(app).get("/tickets").set(GZIP);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });

  it("leaves the MCP endpoint alone", async () => {
    const { app } = buildTestApp();
    const key = await issueKey(app);
    const res = await request(app)
      .post("/mcp")
      .set(GZIP)
      .set("Authorization", `Bearer ${key}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    expect(res.status).toBe(200);
    // Large enough to be compressed, but its stream is marked no-transform, which is honoured.
    expect(res.text.length).toBeGreaterThan(2000);
    expect(res.headers["cache-control"]).toContain("no-transform");
    expect(res.headers["content-encoding"]).toBeUndefined();
  });
});

describe("cache headers on static files", () => {
  it("lets a browser keep a stylesheet for ten minutes, then check it", async () => {
    const { app } = buildTestApp();
    // Only files that are in the repository: the compiled browser scripts under /assets/js exist
    // only after a build, and this suite runs before one.
    for (const file of ["/assets/site.css", "/assets/pico.min.css", "/assets/mark.svg"]) {
      const res = await request(app).get(file);
      expect(res.status, file).toBe(200);
      expect(res.headers["cache-control"], file).toBe("public, max-age=600");
      expect(res.headers["etag"], file).toBeDefined();
    }
  });

  it("lets a browser keep a font for a day", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get("/assets/inter/inter-latin-400-normal.woff2");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("answers a repeat request with 304 when the file has not changed", async () => {
    const { app } = buildTestApp();
    const first = await request(app).get("/assets/site.css");
    const again = await request(app)
      .get("/assets/site.css")
      .set("If-None-Match", first.headers["etag"] as string);
    expect(again.status).toBe(304);
  });
});

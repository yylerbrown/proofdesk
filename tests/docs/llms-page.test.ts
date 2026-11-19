import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ACTIONS } from "../../src/server/api/actions.js";
import { seedDemo } from "../../src/server/demo.js";
import { HINTS } from "../../src/server/errors.js";
import { TOOL_ACTIONS } from "../../src/server/mcp.js";
import { AGENT_SCOPES } from "../../src/server/permissions.js";
import { createTicketService } from "../../src/server/tickets/service.js";
import { buildTestApp, PRODUCTION_SIGN_IN_ENV, visitor } from "../helpers.js";

// The one page an assistant reads once, at /llms.txt and /llms-full.txt. It is built from the
// action table, so these tests tie its list of actions to that table, and check that a
// visitor who is not signed in can read it and every address it names on this site.

/** The page, fetched with no cookie and no key. */
async function fetchPage(env: NodeJS.ProcessEnv | Express, path = "/llms.txt") {
  const app = typeof env === "function" ? env : buildTestApp(env).app;
  const res = await request(app).get(path);
  expect(res.status, res.text).toBe(200);
  expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
  return res.text;
}

/** One action's section of the page, from its heading to the next one. */
function sectionOf(page: string, name: string): string {
  const start = page.indexOf(`### ${name}\n`);
  expect(start, name).toBeGreaterThan(0);
  const next = page.indexOf("\n### ", start + 1);
  const end = next === -1 ? page.indexOf("\n## ", start) : next;
  return page.slice(start, end);
}

/** The field names an action takes, from its zod schemas. */
function fieldNames(schema: z.ZodType | undefined): string[] {
  if (schema === undefined) return [];
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, unknown>;
  };
  return Object.keys(json.properties ?? {});
}

describe("the page for assistants", () => {
  it.each([
    ["the demo", { DEMO: "on", DEV_SIGN_IN: "off" }],
    ["the real site", { NODE_ENV: "production" }],
  ])("is served to a visitor who is not signed in, on %s", async (_name, env) => {
    const { app } = buildTestApp(env);
    const page = await fetchPage(app);
    expect(page.startsWith("# Proofdesk\n")).toBe(true);
    // A test request reaches a new local port each time, so the address is set aside.
    const local = /http:\/\/127\.0\.0\.1:\d+/g;
    const full = await fetchPage(app, "/llms-full.txt");
    expect(full.replace(local, "")).toBe(page.replace(local, ""));
  });

  it("lists every action in the action table, in its order, and nothing else", async () => {
    const page = await fetchPage({});
    const actions = page.slice(page.indexOf("\n## Actions\n"), page.indexOf("\n## Errors\n"));
    const headings = [...actions.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(ACTIONS.map((row) => row.name));
  });

  it("gives each action its address, its inputs and whether it is an MCP tool", async () => {
    const page = await fetchPage({});
    for (const row of ACTIONS) {
      const section = sectionOf(page, row.name);
      expect(section).toContain(`\`${row.method.toUpperCase()} /api${row.path}\``);
      expect(section).toContain(row.summary);
      for (const field of [...fieldNames(row.query), ...fieldNames(row.body)])
        expect(section, `${row.name} ${field}`).toContain(`- \`${field}\` (`);
      const tool = TOOL_ACTIONS.includes(row);
      expect(section.includes(`MCP tool \`${row.name}\``), row.name).toBe(tool);
    }
  });

  it("names every scope and every error code the API can answer", async () => {
    const page = await fetchPage({});
    for (const scope of AGENT_SCOPES) expect(page).toContain(`| \`${scope}\` |`);
    for (const code of Object.keys(HINTS)) expect(page).toContain(`| \`${code}\` |`);
  });

  it("uses the server's own address, and every address it names answers without sign-in", async () => {
    const { app } = buildTestApp({ NODE_ENV: "production" });
    const page = (await request(app).get("/llms.txt")).text;
    const base = PRODUCTION_SIGN_IN_ENV.BETTER_AUTH_URL;
    expect(page).toContain(`${base}/mcp`);
    const named = new Set(
      [...page.matchAll(new RegExp(`${base}(/[a-z./-]*)(?=[\\s|)])`, "g"))].map((m) => m[1]!),
    );
    // The MCP endpoint and the ticket list are the addresses a key is for; the rest are open.
    const needKey = ["/mcp", "/api/tickets"];
    const open = [...named].filter((path) => !needKey.includes(path));
    expect(open).toEqual(expect.arrayContaining(["/api", "/api/openapi.json"]));
    for (const path of open) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
    }
  });
});

describe("the links to the page for assistants", () => {
  it("are in the API guide", async () => {
    const guide = (await visitor(buildTestApp().app).get("/api")).body;
    expect(guide.addresses.llms).toMatch(/\/llms\.txt$/);
  });

  it("are in the assistant setup page's part for other assistants", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const res = await visitor(app).post("/demo/connection");
    expect(res.status, res.text).toBe(200);
    const html = parse(res.text);
    const other = html.querySelectorAll("h2").find((h) => h.text === "Other assistants");
    expect(other).toBeDefined();
    const after = res.text.slice(res.text.indexOf("<h2>Other assistants</h2>"));
    expect(after).toContain('href="/llms.txt"');
  });
});

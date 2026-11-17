import fs from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { SIGN_IN_LIMIT } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { buildTestApp, visitor } from "./helpers.js";

const flyToml = fs.readFileSync("fly.toml", "utf8");
const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const deployWorkflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");

/** The value of `key = "value"` or `key = 3000` in fly.toml. */
function flySetting(key: string): string {
  const match = new RegExp(`^\\s*${key} = "?([^"\\n]+)"?$`, "m").exec(flyToml);
  if (match === null) throw new Error(`fly.toml has no ${key}`);
  return match[1]!;
}

describe("fly.toml agrees with the rest of the repository", () => {
  it("sends traffic to the port the image listens on", () => {
    expect(dockerfile).toContain(`EXPOSE ${flySetting("internal_port")}`);
    expect(flySetting("PORT")).toBe(flySetting("internal_port"));
  });

  it("mounts the disk where the database file lives", () => {
    const databasePath = flySetting("DATABASE_PATH");
    expect(databasePath.startsWith(`${flySetting("destination")}/`)).toBe(true);
  });

  it("checks a health address that answers 200", async () => {
    const { app } = buildTestApp();
    const res = await request(app).get(flySetting("path"));
    expect(res.status).toBe(200);
  });

  it("keeps exactly one machine running, because SQLite lives on its disk", () => {
    expect(flySetting("auto_stop_machines")).toBe("off");
    expect(flySetting("min_machines_running")).toBe("1");
  });

  it("names a client address header the configuration accepts", () => {
    const config = loadConfig({ CLIENT_IP_HEADER: flySetting("CLIENT_IP_HEADER") });
    expect(config.clientIpHeader).toBe("fly-client-ip");
  });
});

describe("the deploy workflow", () => {
  it("runs only when started by hand, never on a push or a merge", () => {
    const triggers = /^on:\n((?: {2}.*\n)+)/m.exec(deployWorkflow)?.[1] ?? "";
    expect(triggers.trim()).toBe("workflow_dispatch:");
  });

  it("takes the deploy token from a repository secret, never from the file", () => {
    expect(deployWorkflow).toContain("FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}");
  });
});

describe("the visitor's address behind a proxy", () => {
  it("gives two visitors behind the same proxy separate limits", async () => {
    const env = {
      CLIENT_IP_HEADER: "fly-client-ip",
      DEV_SIGN_IN: "off",
      BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
      BETTER_AUTH_URL: "http://desk.test",
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
    };
    const { app } = buildTestApp(env);
    const start = (address: string) =>
      visitor(app).post("/sign-in/github").set("fly-client-ip", address);
    for (let i = 0; i < SIGN_IN_LIMIT; i++) {
      expect((await start("203.0.113.1")).status).toBe(303);
    }
    expect((await start("203.0.113.1")).status).toBe(429);
    // Another visitor, through the same proxy connection, is not held back.
    expect((await start("198.51.100.7")).status).toBe(303);
  });

  it("without the setting, counts everyone on one connection together", async () => {
    const env = {
      DEV_SIGN_IN: "off",
      BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
      BETTER_AUTH_URL: "http://desk.test",
      GITHUB_CLIENT_ID: "test-client-id",
      GITHUB_CLIENT_SECRET: "test-client-secret",
    };
    const { app } = buildTestApp(env);
    const start = (address: string) =>
      visitor(app).post("/sign-in/github").set("fly-client-ip", address);
    for (let i = 0; i < SIGN_IN_LIMIT; i++) await start("203.0.113.1");
    expect((await start("198.51.100.7")).status).toBe(429);
  });

  it("refuses a header name that is not a plain lower-case name", () => {
    expect(() => loadConfig({ CLIENT_IP_HEADER: "Fly-Client-IP" })).toThrow(/CLIENT_IP_HEADER/);
    expect(() => loadConfig({ CLIENT_IP_HEADER: "a b" })).toThrow(/CLIENT_IP_HEADER/);
  });
});

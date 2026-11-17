import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      nodeEnv: "development",
      port: 3000,
      databasePath: "./data/app.db",
      gitCommit: undefined,
    });
  });

  it("reads values from the environment", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PORT: "8080",
      DATABASE_PATH: "/data/app.db",
      GIT_COMMIT: "abc123",
    });
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe("production");
    expect(config.databasePath).toBe("/data/app.db");
    expect(config.gitCommit).toBe("abc123");
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ PORT: "", GIT_COMMIT: "" }).port).toBe(3000);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});

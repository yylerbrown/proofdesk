import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { PRODUCTION_SIGN_IN_ENV, SIGN_IN_ENV } from "./helpers.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      nodeEnv: "development",
      port: 3000,
      databasePath: "./data/app.db",
      gitCommit: undefined,
      ticketPrefix: "SUP",
      devSignIn: false,
      signIn: null,
      clientIpHeader: undefined,
      teamGithubIds: [],
      adminGithubIds: [],
    });
  });

  it("reads values from the environment", () => {
    const config = loadConfig({
      ...PRODUCTION_SIGN_IN_ENV,
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

  it("reads TICKET_PREFIX and rejects a bad one", () => {
    expect(loadConfig({ TICKET_PREFIX: "HELP" }).ticketPrefix).toBe("HELP");
    for (const bad of ["S", "TOOLONGX", "sup", "SU1", "SU-P"]) {
      expect(() => loadConfig({ TICKET_PREFIX: bad })).toThrow(/TICKET_PREFIX/);
    }
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });

  it("opens the development entrance only when asked, and never in production", () => {
    expect(loadConfig({}).devSignIn).toBe(false);
    expect(loadConfig({ DEV_SIGN_IN: "on" }).devSignIn).toBe(true);
    expect(() => loadConfig({ DEV_SIGN_IN: "yes" })).toThrow(/DEV_SIGN_IN/);
    expect(() => loadConfig({ NODE_ENV: "production", DEV_SIGN_IN: "on" })).toThrow(
      /DEV_SIGN_IN must not be on in production/,
    );
    expect(loadConfig({ ...PRODUCTION_SIGN_IN_ENV, NODE_ENV: "production" }).devSignIn).toBe(false);
  });

  it("reads the GitHub sign-in settings as a set", () => {
    expect(loadConfig(SIGN_IN_ENV).signIn).toEqual({
      secret: SIGN_IN_ENV.BETTER_AUTH_SECRET,
      baseUrl: SIGN_IN_ENV.BETTER_AUTH_URL,
      githubClientId: SIGN_IN_ENV.GITHUB_CLIENT_ID,
      githubClientSecret: SIGN_IN_ENV.GITHUB_CLIENT_SECRET,
    });
    expect(() => loadConfig({ ...SIGN_IN_ENV, GITHUB_CLIENT_SECRET: "" })).toThrow(
      /also set GITHUB_CLIENT_SECRET/,
    );
    expect(() => loadConfig({ ...SIGN_IN_ENV, BETTER_AUTH_SECRET: "too short" })).toThrow(
      /BETTER_AUTH_SECRET: must be at least 32 characters/,
    );
    expect(() => loadConfig({ ...SIGN_IN_ENV, BETTER_AUTH_URL: "not a url" })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it("refuses to start in production without the sign-in settings", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      /sign-in is required in production. Set BETTER_AUTH_SECRET, BETTER_AUTH_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET/,
    );
    expect(loadConfig({ NODE_ENV: "development" }).signIn).toBeNull();
  });

  it("refuses a plain http address in production", () => {
    expect(() =>
      loadConfig({
        ...PRODUCTION_SIGN_IN_ENV,
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://desk.test",
      }),
    ).toThrow(/BETTER_AUTH_URL must start with https:\/\/ in production/);
    // A development machine may use plain http.
    expect(loadConfig(SIGN_IN_ENV).signIn?.baseUrl).toBe("http://desk.test");
  });

  it("reads the team and admin lists as GitHub user numbers", () => {
    const config = loadConfig({ TEAM_GITHUB_IDS: "2002,2003", ADMIN_GITHUB_IDS: "1001" });
    expect(config.teamGithubIds).toEqual(["2002", "2003"]);
    expect(config.adminGithubIds).toEqual(["1001"]);
    expect(() => loadConfig({ ADMIN_GITHUB_IDS: "some-name" })).toThrow(/ADMIN_GITHUB_IDS/);
    expect(() => loadConfig({ TEAM_GITHUB_IDS: "1, 2" })).toThrow(/TEAM_GITHUB_IDS/);
  });
});

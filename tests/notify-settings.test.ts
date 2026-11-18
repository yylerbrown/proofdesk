import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";
import { createNotifier } from "../src/server/notify/notifier.js";
import { notifySettingsOf } from "../src/server/notify/outbox.js";
import { buildTestApp } from "./helpers.js";

// The two mail settings: SMTP_URL and MAIL_FROM, both or neither. The address of the mail
// server can carry its password, which never shows in an error, a log line or a page.

const PASSWORD = "pw-NEVER-SHOWN-4417";
const SMTP_URL = `smtps://notices:${PASSWORD}@mail.example.com:465`;
const MAIL_FROM = "notices@example.com";

/** The message loadConfig throws for these settings. */
function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("Expected the settings to be refused.");
}

describe("the mail settings", () => {
  it("are read as a pair", () => {
    expect(loadConfig({ SMTP_URL, MAIL_FROM }).mail).toEqual({
      smtpUrl: SMTP_URL,
      from: MAIL_FROM,
    });
    expect(loadConfig({}).mail).toBeNull();
    expect(notifySettingsOf(loadConfig({ SMTP_URL, MAIL_FROM })).mailConfigured).toBe(true);
    expect(notifySettingsOf(loadConfig({})).mailConfigured).toBe(false);
  });

  it("refuse one without the other, without quoting the password", () => {
    const message = refusal({ SMTP_URL });
    expect(message).toMatch(/also set MAIL_FROM, or neither/);
    expect(message).not.toContain(PASSWORD);
    expect(refusal({ MAIL_FROM })).toMatch(/also set SMTP_URL, or neither/);
  });

  it("refuse an address that is not a mail server's, or a sender that is not an address", () => {
    const wrongKind = refusal({
      SMTP_URL: `https://notices:${PASSWORD}@mail.example.com`,
      MAIL_FROM,
    });
    expect(wrongKind).toMatch(/SMTP_URL: must be an smtp:\/\/ or smtps:\/\/ address/);
    expect(wrongKind).not.toContain(PASSWORD);
    expect(refusal({ SMTP_URL, MAIL_FROM: "notices" })).toMatch(
      /MAIL_FROM: must be an email address/,
    );
    // A line break can never get into the sender's address.
    expect(refusal({ SMTP_URL, MAIL_FROM: "notices@example.com\r\nBcc: x@example.com" })).toMatch(
      /MAIL_FROM/,
    );
  });

  it("are ignored on the demo, which never sends", () => {
    expect(loadConfig({ DEMO: "on", SMTP_URL, MAIL_FROM }).mail).toBeNull();
  });

  it("never show the password in the health check or the start-up line", async () => {
    const { app, db, config } = buildTestApp({ SMTP_URL, MAIL_FROM });
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.text).not.toContain(PASSWORD);
    expect(health.text).not.toContain("mail.example.com");
    const lines: string[] = [];
    const notifier = createNotifier({ config, currentDb: () => db, log: (l) => lines.push(l) });
    notifier.start();
    notifier.stop();
    expect(lines).toEqual(["Email notices are sent through the mail server that is set."]);
  });
});

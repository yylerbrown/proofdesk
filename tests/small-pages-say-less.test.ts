import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { adminActor, as, buildTestApp, visitor } from "./helpers.js";

// The small pages each have one heading, their title, and say each thing once: Account keeps
// its email switch as the last row of its list, and the admin's connections page names
// assistants, never agents.

const DEMO = { DEMO: "on", DEV_SIGN_IN: "off" };

describe("the account page", () => {
  it("has one heading, with the email switch as the list's last row", async () => {
    const { app } = buildTestApp();
    const main = parse((await as(app, adminActor).get("/account")).text).querySelector("main")!;
    expect(main.querySelectorAll("h1, h2, h3").map((h) => h.text)).toEqual(["Your account"]);
    const terms = main.querySelectorAll("dl > dt").map((dt) => dt.text);
    expect(terms.at(-1)).toBe("Email notices");
    expect(main.querySelector("dl > dd:last-child form.email-me")).not.toBeNull();
  });

  it("names the demo admin as read-only", async () => {
    const { app } = buildTestApp(DEMO);
    const page = await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-admin`).get("/account");
    expect(parse(page.text).querySelector(".account-name")?.text).toBe("Demo Admin (read-only)");
  });
});

describe("the connections page", () => {
  it("is headed Assistant connections, and its tab says so too", async () => {
    const { app } = buildTestApp();
    const html = parse((await as(app, adminActor).get("/connections")).text);
    expect(html.querySelector("main h1")?.text).toBe("Assistant connections");
    expect(html.querySelector("title")?.text).toBe("Assistant connections - Proofdesk");
    expect(html.querySelector("main")!.text).not.toContain("AI agent");
  });
});

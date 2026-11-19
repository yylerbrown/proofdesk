import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { tryItUrl } from "../src/server/routes/assistant-run.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { adminActor, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The page about an assistant's work opens with what the assistant did and one press to the
// ticket that shows it. How the run was set up stays in one closed section below.

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const tickets = createTicketService(built.db, built.config.ticketPrefix);
  seedDemo(tickets);
  return { ...built, recordedKey: tickets.recordedRunKey()! };
}

const VIEWERS = ["signed out", "demo-customer", "demo-team", "demo-admin"];

async function pageFor(app: ReturnType<typeof demo>["app"], who: string) {
  const browser =
    who === "signed out" ? visitor(app) : visitor(app).set("Cookie", `${DEV_COOKIE}=${who}`);
  return parse((await browser.get("/assistant-run")).text).querySelector(".assistant-run")!;
}

describe("the assistant run page, first look", () => {
  it("opens with what happened, the way to the result, what it left, then the closed details", async () => {
    const { app } = demo();
    for (const who of VIEWERS) {
      const page = await pageFor(app, who);
      const order = page.children.map((child) => child.classList.value[0] ?? child.tagName);
      expect(order, who).toEqual([
        "H1",
        "run-lead",
        "run-result",
        "run-left-heading",
        "run-left",
        "run-try",
        "run-details",
      ]);
      expect(page.querySelector("p.run-lead")?.text, who).toContain("It resolved nothing");
      expect(page.querySelectorAll("ul.run-left li").length, who).toBe(3);
    }
  });

  it("keeps every detail of how it was run inside one closed section, with nothing removed", async () => {
    const { app } = demo();
    for (const who of VIEWERS) {
      const page = await pageFor(app, who);
      const details = page.querySelector("details.run-details")!;
      expect(details.querySelector("summary")?.text, who).toBe("How this was run");
      expect(details.hasAttribute("open"), who).toBe(false);
      for (const part of [
        ".run-summary",
        "dl.run-facts",
        "pre.run-command",
        "a[href='/assistant-run/files/transcript.public.jsonl']",
        "a[href='/assistant-run/files/sup4/total.js']",
        "a[href='/assistant-run/files/sup4/total.test.js']",
      ]) {
        expect(details.querySelector(part), `${who} ${part}`).not.toBeNull();
        expect(page.querySelectorAll(part).length, `${who} ${part}`).toBe(1);
      }
    }
  });

  it("points every viewer at the recorded ticket from the seed, as a link or one press", async () => {
    const { app, recordedKey } = demo();
    for (const who of ["demo-team", "demo-admin"]) {
      const link = (await pageFor(app, who)).querySelector(".run-result a[role='button']");
      expect(link?.getAttribute("href"), who).toBe(`/tickets/${recordedKey}`);
    }
    for (const who of ["signed out", "demo-customer"]) {
      const result = (await pageFor(app, who)).querySelector(".run-result")!;
      expect(result.querySelector("p")?.text, who).toContain("Only the team can open that ticket");
      expect(result.querySelector("input[name='next']")?.getAttribute("value"), who).toBe(
        `/tickets/${recordedKey}`,
      );
    }
  });

  it("says quietly how to try it, linking to the welcome page's connect section", async () => {
    const { app } = demo();
    for (const who of VIEWERS) {
      const link = (await pageFor(app, who)).querySelector("p.run-try a");
      expect(link?.getAttribute("href"), who).toBe("/sign-in#connect");
    }
    const welcome = parse((await visitor(app).get("/sign-in")).text);
    expect(welcome.querySelector("#connect")).not.toBeNull();
  });
});

describe("where to try it yourself", () => {
  it("is the welcome page on the demo, and an admin's connections page elsewhere", () => {
    expect(tryItUrl(true, null)).toBe("/sign-in#connect");
    expect(tryItUrl(false, adminActor)).toBe("/connections");
    expect(tryItUrl(false, teamActor)).toBeNull();
    expect(tryItUrl(false, customerOne)).toBeNull();
    expect(tryItUrl(false, null)).toBeNull();
  });

  it("shows no try line and no recorded ticket on a site without the demo", async () => {
    const { app } = buildTestApp();
    const page = parse(
      (await visitor(app).set("Cookie", `${DEV_COOKIE}=${teamActor.id}`).get("/assistant-run"))
        .text,
    );
    expect(page.querySelector("p.run-try")).toBeNull();
    expect(page.querySelector(".run-result")).toBeNull();
    const asAdmin = parse(
      (await visitor(app).set("Cookie", `${DEV_COOKIE}=${adminActor.id}`).get("/assistant-run"))
        .text,
    );
    expect(asAdmin.querySelector("p.run-try a")?.getAttribute("href")).toBe("/connections");
  });
});

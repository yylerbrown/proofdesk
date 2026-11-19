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
  it("opens with what happened and the way to the result, then the closed details", async () => {
    const { app } = demo();
    for (const who of VIEWERS) {
      const page = await pageFor(app, who);
      const order = page.children.map((child) => child.classList.value[0] ?? child.tagName);
      expect(order, who).toEqual(["H1", "run-lead", "run-result", "run-try", "run-details"]);
      // Two sentences, and the button shows what it left, so no list repeats it.
      const lead = page.querySelector("p.run-lead")!.text;
      expect(lead.split(". ").length, who).toBe(2);
      expect(lead, who).toContain("it resolved nothing");
      expect(page.text, who).not.toContain("What it left on the ticket");
    }
  });

  it("says the run's scope in its first sentence, and claims only what the run shows", async () => {
    const { app } = demo();
    const lead = (await pageFor(app, "signed out")).querySelector("p.run-lead")!.text;
    const first = lead.slice(0, lead.indexOf(". ") + 1);
    expect(first).toContain("in a scratch file, from the ticket's text");
    expect(first).toContain("because it had no access to the product's code");
    // What it did there, as the run's summary records it.
    expect(lead).toContain("reproduced the problem, tested a fix that passed three tests");
    expect(lead).toContain("asked the owner to review");
    // Never the wider claim that it reproduced the customer's problem itself.
    expect(lead).not.toContain("reproduced the customer's problem");
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

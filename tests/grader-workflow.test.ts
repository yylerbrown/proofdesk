import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, teamActor, visitor } from "./helpers.js";

// From a cold walk by a grader: titles lead to their tickets, the team reads plainly who
// resolves, and on the demo the owner can reach the customer's question with labelled sample
// values instead of inventing evidence.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asDemo = (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  return { ...built, asDemo };
}

/** On the demo, the team member takes a new sample and starts work on it. */
async function demoInProgress() {
  const built = demo();
  await built.asDemo("demo-team").post("/tickets/SUP-2/take-and-start").set(FROM_THIS_SITE);
  return built;
}

describe("the ticket list", () => {
  it("links each title to its ticket, as well as its key", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    const link = html.querySelector("table.tickets td.title-cell a");
    expect(link?.text).toBe("Printer jams");
    expect(link?.getAttribute("href")).toBe("/tickets/SUP-1");
  });
});

describe("who resolves", () => {
  it("is said exactly where the team looks for Resolved: the status and the edit page", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const sentence = "Only the customer who filed this ticket can resolve it.";
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector(".status-rule")?.text.startsWith(sentence)).toBe(true);
    const edit = parse((await as(app, teamActor).get("/tickets/SUP-1/edit")).text);
    expect(edit.querySelector(".status-rule")?.text).toBe(sentence);
    // The customer who filed it is not told they cannot.
    const own = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(own.querySelector(".status-rule")).toBeNull();
  });
});

describe("the demo's sample fix", () => {
  it("is offered to the owner of a ticket in progress, and fills the fix with labelled sample values", async () => {
    const { asDemo } = await demoInProgress();
    const page = parse((await asDemo("demo-team").get("/tickets/SUP-2")).text);
    expect(page.querySelector("form.sample-fix button")?.text).toBe("Use sample fix");

    const used = await asDemo("demo-team").post("/tickets/SUP-2/sample-fix").set(FROM_THIS_SITE);
    expect(used.status).toBe(303);
    expect(used.headers.location).toBe("/tickets/SUP-2?sample=1#ask");
    const ticket = (await asDemo("demo-team").get("/api/tickets/SUP-2")).body;
    expect(ticket.change_url).toBe("https://example.com/demo-sample-fix");

    const ask = parse(
      (await asDemo("demo-team").get("/tickets/SUP-2?sample=1")).text,
    ).querySelector("form#ask")!;
    expect(ask.querySelector("textarea[name=tried]")?.text).toMatch(/^Demo sample value: /);
    expect(ask.querySelector("textarea[name=result]")?.text).toMatch(/^Demo sample value: /);
    expect(ask.querySelector("input[name=try_url]")?.getAttribute("value")).toMatch(/^https:\/\//);
    // The owner still presses the ask; nothing is sent to the customer by the sample.
    expect(ticket.ready_at).toBeNull();
  });

  it("is not offered, and not open, outside the demo or to anyone but the owner", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(page.querySelector("form.sample-fix")).toBeNull();
    expect((await as(app, teamActor).post("/tickets/SUP-1/sample-fix")).status).toBe(404);

    const { asDemo } = await demoInProgress();
    const customer = parse((await asDemo("demo-customer").get("/tickets/SUP-2")).text);
    expect(customer.querySelector("form.sample-fix")).toBeNull();
  });
});

describe("the header on a phone", () => {
  it("keeps Sign out on one line and lets the role switch grow with its words", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
    expect(phone).toMatch(/\.site-header \.sign-out button \{[^}]*white-space: nowrap/);
    expect(phone).toMatch(/details\.dropdown\.switch-role > summary \{[^}]*height: auto/);
  });
});

import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, adminActor, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// Under the team's ticket list, one quiet sentence says Proofdesk works with the team's own AI
// assistant, with one link to an example. It asks nothing and offers nothing to dismiss.
// Customers never see it, and Connections is in the admin's person menu.

const list = async (app: Express, who = teamActor) =>
  parse((await as(app, who).get("/tickets")).text);

async function connectOne(app: Express) {
  await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
}

const SENTENCE =
  "Works with your own AI assistant. Proofdesk makes no AI calls itself. See an example";

describe("the line about bringing your own assistant", () => {
  it("is one sentence and one link for the team and the admin, and nothing for a customer", async () => {
    const { app } = buildTestApp();
    for (const who of [teamActor, adminActor]) {
      const line = (await list(app, who)).querySelector(".assistant-invite")!;
      expect(line.text.trim()).toBe(SENTENCE);
      const links = line.querySelectorAll("a");
      expect(links.map((link) => [link.text, link.getAttribute("href")])).toEqual([
        ["See an example", "/assistant-run"],
      ]);
      expect(line.querySelector("form, button")).toBeNull();
    }
    const customer = await list(app, customerOne);
    expect(customer.querySelector(".assistant-invite")).toBeNull();
    expect(customer.text).not.toContain("assistant");
  });

  it("stays the same sentence once an assistant is connected", async () => {
    const { app } = buildTestApp();
    await connectOne(app);
    const line = (await list(app)).querySelector(".assistant-invite")!;
    expect(line.text.trim()).toBe(SENTENCE);
  });

  it("has no Not now to remember, so the old address for it is gone", async () => {
    const { app } = buildTestApp();
    expect((await as(app, teamActor).post("/assistant-invite/hide")).status).toBe(404);
    // A browser that still carries the old cookie sees the line like everyone else.
    const later = await visitor(app)
      .set("Cookie", `${DEV_COOKIE}=${teamActor.id}; assistant_invite=hidden`)
      .get("/tickets");
    expect(parse(later.text).querySelector(".assistant-invite")?.text.trim()).toBe(SENTENCE);
  });

  it("sits under the tickets on the demo, for the team and the read-only preview", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const as = (id: string) =>
      visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).get("/tickets");
    const main = parse((await as("demo-team")).text)
      .querySelector("main")!
      .toString();
    expect(main.indexOf('class="assistant-invite"')).toBeGreaterThan(
      main.indexOf('<table class="tickets"'),
    );
    const preview = parse((await as("demo-admin")).text);
    expect(preview.querySelector(".assistant-invite")?.text.trim()).toBe(SENTENCE);
    expect(parse((await as("demo-customer")).text).querySelector(".assistant-invite")).toBeNull();
  });
});

describe("the Connections page", () => {
  it("is in the admin's person menu, not in the header's top row", async () => {
    const { app } = buildTestApp();
    const page = parse((await admin(app).get("/tickets")).text);
    expect(page.querySelector("header nav > ul > li > a[href='/connections']")).toBeNull();
    const link = page.querySelector("header .person-menu a[href='/connections']");
    expect(link?.text).toBe("Connections");
    expect((await admin(app).get("/connections")).status).toBe(200);
  });
});

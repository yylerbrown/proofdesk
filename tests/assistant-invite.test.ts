import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, adminActor, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The team is invited to bring its own AI assistant where it starts the day, the ticket list,
// until one is connected. Customers never see any of it, and Connections is no longer a header
// link: an admin reaches it from the invitation and from the admin's note.

const list = async (app: Express, who = teamActor) =>
  parse((await as(app, who).get("/tickets")).text);

async function connectOne(app: Express) {
  await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "write_notes"] });
}

describe("the invitation to connect an assistant", () => {
  it("asks the team and the admin, says what an assistant does here, and never asks a customer", async () => {
    const { app } = buildTestApp();
    const team = (await list(app)).querySelector(".assistant-invite")!;
    // One quiet sentence: what an assistant does first, then what Proofdesk does not do.
    expect(team.querySelector("p")?.text).toBe(
      "Connect your own AI assistant: it reproduces a ticket's problem and tests a fix, for a person to check. Proofdesk makes no AI calls itself.",
    );
    // A team member cannot connect one, so they are told who can instead of shown a button.
    expect(team.querySelector("a[href='/connections']")).toBeNull();
    expect(team.querySelector(".invite-who")?.text).toBe("Only an admin can connect an assistant.");
    expect(team.querySelector("a[href='/assistant-run']")?.text).toBe("See an assistant's work");

    const asAdmin = (await list(app, adminActor)).querySelector(".assistant-invite")!;
    const primary = asAdmin.querySelector(".invite-actions a")!;
    expect([primary.text, primary.getAttribute("href")]).toEqual([
      "Connect your assistant",
      "/connections",
    ]);

    const customer = await list(app, customerOne);
    expect(customer.querySelector(".assistant-invite, .assistant-connected")).toBeNull();
    expect(customer.text).not.toContain("assistant");
  });

  it("becomes one quiet line once an assistant is connected", async () => {
    const { app } = buildTestApp();
    await connectOne(app);
    const team = await list(app);
    expect(team.querySelector(".assistant-invite")).toBeNull();
    expect(team.querySelector(".assistant-connected")?.text).toBe(
      "1 assistant connected · See an assistant's work",
    );
    const asAdmin = parse((await admin(app).get("/tickets")).text);
    expect(asAdmin.querySelector(".assistant-connected a")?.getAttribute("href")).toBe(
      "/connections",
    );
  });

  it("hides for a person who says Not now, without a script", async () => {
    const { app } = buildTestApp();
    const res = await as(app, teamActor).post("/assistant-invite/hide");
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/tickets");
    expect(String(res.headers["set-cookie"])).toMatch(/^assistant_invite=hidden;.*HttpOnly/);
    const later = await visitor(app)
      .set("Cookie", `${DEV_COOKIE}=${teamActor.id}; assistant_invite=hidden`)
      .get("/tickets");
    expect(parse(later.text).querySelector(".assistant-invite")).toBeNull();
    // Someone else in another browser is still asked.
    expect((await list(app)).querySelector(".assistant-invite")).not.toBeNull();
  });

  it("on the demo, points the team at the welcome page's demo connection", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const as = (id: string) =>
      visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).get("/tickets");
    const team = parse((await as("demo-team")).text).querySelector(".assistant-invite")!;
    expect(team.querySelector(".invite-actions a")?.getAttribute("href")).toBe("/sign-in#connect");
    expect(parse((await as("demo-customer")).text).querySelector(".assistant-invite")).toBeNull();
  });

  it("sits under the tickets, never above them, and is not shown to the read-only preview", async () => {
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
    // The preview can connect nothing, so it is not invited to.
    const preview = parse((await as("demo-admin")).text);
    expect(preview.querySelector(".assistant-invite, .assistant-connected")).toBeNull();
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

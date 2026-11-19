import fs from "node:fs";
import type { Express } from "express";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { READ_ONLY_REFUSAL } from "../src/server/errors.js";
import { createTicketSchema } from "../src/server/tickets/schemas.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  refusedBackToTicket,
  teamActor,
  visitor,
} from "./helpers.js";

// Resolving with a reason asks for a real choice, a long text with line breaks is counted the
// way the browser counts it, a resolved ticket offers only what still makes sense, and the
// customer's latest word is the one shown at the top.

const filed = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const ask = { try_url: "https://example.com/t", tried: "Printed.", result: "No jam." };

/** SUP-1 filed by the customer, and taken and started by the team member. */
async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return built;
}

/** The team asks the customer, and the customer answers No with these words. */
async function customerSaysNo(app: Express, words: string) {
  const asked = (await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask)).body;
  const answered = await as(app, customerOne)
    .post("/api/tickets/SUP-1/answer")
    .send({ fixed: "no", comment: words, ready_token: asked.ready_token });
  expect(answered.status).toBe(200);
}

const ticketPage = async (app: Express, who = teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text);
/** The ticket page with the resolve form shown, as the Status menu's Resolved opens it. */
const resolvePage = async (app: Express) =>
  parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text);

describe("the resolve form", () => {
  it("starts on an empty, required choice while the customer's No stands", async () => {
    const { app } = await setup();
    // Otherwise it starts on the "Fixed." reason (status-row-reads-as-one-control).
    await customerSaysNo(app, "Still jams on page two.");
    const radios = (await resolvePage(app)).querySelectorAll('form.resolve input[name="reason"]');
    expect(radios.every((radio) => radio.hasAttribute("required"))).toBe(true);
    expect(radios.some((radio) => radio.hasAttribute("checked"))).toBe(false);
    // Sent without a choice anyway, it is refused and the ticket stays open.
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "", note: "" });
    expect(refused.status).toBe(400);
    expect(parse(refused.text).querySelector("#resolve-error")?.text).toBe("Choose a reason.");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("offers 'the customer has not replied' only while that is true", async () => {
    const { app } = await setup();
    const values = async () =>
      (await resolvePage(app))
        .querySelectorAll('form.resolve input[name="reason"]')
        .map((radio) => radio.getAttribute("value"));
    expect(await values()).toContain("fixed_no_reply");
    await customerSaysNo(app, "Still jams on page two.");
    expect(await values()).toEqual(["duplicate", "wont_fix", "cannot_reproduce", "other"]);
    // Sent anyway, the service refuses it beside the reason.
    const res = await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "fixed_no_reply" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe(
      "The customer said it is not fixed. Choose another reason.",
    );
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("marks the duplicate and note boxes, which the stylesheet shows only when used", async () => {
    const { app } = await setup();
    const form = (await resolvePage(app)).querySelector("form.resolve")!;
    expect(form.querySelector('label.resolve-duplicate input[name="duplicate_of"]')).not.toBeNull();
    expect(form.querySelector('label.resolve-note textarea[name="note"]')).not.toBeNull();
    const css = fs.readFileSync(new URL("../public/site.css", import.meta.url), "utf8");
    expect(css).toContain(
      'form.resolve:not(:has(input[value="duplicate"]:checked)) .resolve-duplicate',
    );
    expect(css).toContain('form.resolve:not(:has(input[value="other"]:checked)) .resolve-note');
  });
});

describe("a long text with line breaks", () => {
  // A browser sends each line break as \r\n, and its maxlength counts it as one character.
  const lines = ["First line.", "Second line.", "Third line.", "Fourth line."];
  const exactly = (length: number) => {
    const text = lines.join("\r\n");
    return text + "x".repeat(length - text.replace(/\r\n/g, "\n").length);
  };

  it("is accepted at exactly the allowed length, and stored with plain line breaks", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: exactly(5000) });
    expect(res.status).toBe(303);
    const stored = (await admin(app).get("/api/tickets/SUP-1")).body.description as string;
    expect(stored).toHaveLength(5000);
    expect(stored).not.toContain("\r");
    expect(stored.split("\n")).toHaveLength(lines.length);
  });

  it("is still refused one character over", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: exactly(5001) });
    expect(res.status).toBe(400);
    expect(res.text).toContain("Must be at most 5000 characters.");
  });

  it("is counted the same way in a reply", async () => {
    const { app } = await setup();
    const res = await as(app, teamActor)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: exactly(5000) });
    expect(res.status).toBe(201);
  });

  it("meets a ticket form whose boxes stop at the server's limits", async () => {
    const { app } = buildTestApp();
    const form = parse(
      (await as(app, customerOne).get("/tickets/new").redirects(1)).text,
    ).querySelector('form[action="/tickets"]')!;
    const limit = (name: string) =>
      Number(form.querySelector(`[name="${name}"]`)!.getAttribute("maxlength"));
    const shape = createTicketSchema.shape;
    expect(limit("title")).toBe(shape.title.maxLength);
    // The description counts against the limit instead, so a long paste is never cut off.
    const description = form.querySelector('[name="description"]')!;
    expect(Number(description.getAttribute("data-count-limit"))).toBe(shape.description.maxLength);
    expect(limit("fix_check")).toBe(shape.fix_check.unwrap().maxLength);
    expect(Number(form.querySelector('[name="title"]')!.getAttribute("minlength"))).toBe(
      shape.title.minLength,
    );
  });
});

describe("a resolved ticket", () => {
  it("offers no change link form, before or after resolving", async () => {
    const { app } = await setup();
    const before = await ticketPage(app);
    expect(before.querySelector("form#change-link")).toBeNull();
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "cannot_reproduce" });
    const after = await ticketPage(app);
    expect(after.querySelector("form#change-link")).toBeNull();
    // The plain reply box stays, for a word to the customer after resolving.
    expect(after.querySelector("#entry-body")).not.toBeNull();
  });
});

describe("the card's line after the customer reopens", () => {
  it("says they reopened it, not the older No, and never repeats their words", async () => {
    const { app } = await setup();
    await customerSaysNo(app, "Still jams on page two.");
    const line = async (who = teamActor) =>
      (await ticketPage(app, who)).querySelector(".ticket-card .card-line")?.text.trim() ?? null;
    expect(await line()).toMatch(/^The customer said no on /);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "cannot_reproduce" });
    const reopened = await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It jams again since Monday." });
    expect(reopened.status).toBe(200);
    expect(await line()).toMatch(/^The customer reopened it on /);
    // The customer's own ticket is simply back with the team, so their card has no line.
    expect(await line(customerOne)).toBeNull();
    for (const who of [teamActor, customerOne]) {
      const card = (await ticketPage(app, who)).querySelector(".ticket-card")!;
      expect(card.text).not.toContain("It jams again since Monday.");
      expect(card.text).not.toContain("Still jams on page two.");
    }
  });
});

describe("a refusal the read-only admin preview meets", () => {
  function buildDemo() {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    return built;
  }
  const preview = (app: Express) => visitor(app).set("Cookie", `${DEV_COOKIE}=demo-admin`);

  it("says the preview is read-only and points to Switch role, on the ticket", async () => {
    const { app } = buildDemo();
    expect(await refusedBackToTicket(preview(app), "/tickets/SUP-1/take")).toBe(READ_ONLY_REFUSAL);
    expect(READ_ONLY_REFUSAL).toContain("Use Switch role");
  });

  it("says the same in the API", async () => {
    const { app } = buildDemo();
    const res = await preview(app).post("/api/tickets/SUP-1/entries").send({
      kind: "reply",
      body: "Hello",
    });
    expect([res.status, res.body.error.message]).toEqual([403, READ_ONLY_REFUSAL]);
  });

  it("says it once on an error page", async () => {
    const { app } = buildDemo();
    const res = await preview(app)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer is broken", description: "It jams on every page." });
    expect(res.status).toBe(403);
    const main = parse(res.text).querySelector("main")!.text;
    expect(main.split("The admin preview is read-only.")).toHaveLength(2);
  });

  it("stays the plain refusal for anyone else", async () => {
    const { app } = await setup();
    const res = await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "note", body: "Hello" });
    expect([res.status, res.body.error.message]).toEqual([403, "You are not allowed to do that."]);
  });
});

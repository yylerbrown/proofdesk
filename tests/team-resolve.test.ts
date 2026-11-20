import { parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { TOOL_ACTIONS } from "../src/server/mcp.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The team may resolve a ticket without the customer's Yes, with a reason from a short list. It
// stays Resolved, one of the three statuses, and its label tells the two kinds apart everywhere:
// "Customer confirmed" only from the customer's Yes, "Resolved by the team: <reason>" otherwise.
// The customer sees the reason and can reopen it. An agent never resolves.

const valid = { title: "Printer jams", description: "x", fix_check: "Ten pages print" };
const ask = { try_url: "https://example.com/t", tried: "Printed.", result: "No jam." };

/** SUP-1 filed by the customer, taken and started by the team member; SUP-2 filed and unowned. */
async function setup() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, customerOne)
    .post("/api/tickets")
    .send({ ...valid, title: "Second" });
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  return built;
}

const resolve = (app: Express, body: object, who = teamActor, key = "SUP-1") =>
  as(app, who).post(`/api/tickets/${key}/resolve`).send(body);

describe("resolving with a reason", () => {
  it("is open to the ticket's owner, to a team member on an unowned ticket, and to an admin", async () => {
    const { app } = await setup();
    const res = await resolve(app, { reason: "wont_fix", note: "Works as designed." });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolution).toMatchObject({
      by: "team",
      label: "Resolved by the team: Won't fix",
      reason: "wont_fix",
      note: "Works as designed.",
      resolved_by_name: "Team Member",
    });
    // Nobody owns SUP-2: the team member resolves it without taking it first, and becomes its
    // owner as part of resolving, in the history.
    const unowned = await resolve(app, { reason: "cannot_reproduce" }, undefined, "SUP-2");
    expect(unowned.status).toBe(200);
    expect(unowned.body).toMatchObject({ status: "resolved", owner_name: "Team Member" });
    const events = (await admin(app).get("/api/tickets/SUP-2/events")).body as { type: string }[];
    expect(events.map((event) => event.type).slice(-2)).toEqual([
      "owner_changed",
      "resolved_by_team",
    ]);
    // An admin resolves a ticket someone else owns, which stays theirs.
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ ...valid, title: "Third" });
    await as(app, teamActor).post("/api/tickets/SUP-3/take-and-start");
    const byAdmin = await admin(app).post("/api/tickets/SUP-3/resolve").send({
      reason: "cannot_reproduce",
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.resolution.label).toBe("Resolved by the team: Cannot reproduce");
    expect(byAdmin.body.owner_name).toBe("Team Member");
  });

  it("needs a reason, a note for Other, and an existing other ticket for a duplicate", async () => {
    const { app } = await setup();
    const field = async (body: object) => (await resolve(app, body)).body.error.fields;
    expect(Object.keys(await field({}))).toEqual(["reason"]);
    expect(Object.keys(await field({ reason: "other" }))).toEqual(["note"]);
    expect(Object.keys(await field({ reason: "other", note: "   " }))).toEqual(["note"]);
    expect(Object.keys(await field({ reason: "duplicate" }))).toEqual(["duplicate_of"]);
    expect(Object.keys(await field({ reason: "duplicate", duplicate_of: "SUP-9" }))).toEqual([
      "duplicate_of",
    ]);
    expect(Object.keys(await field({ reason: "duplicate", duplicate_of: "SUP-1" }))).toEqual([
      "duplicate_of",
    ]);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
    const dup = await resolve(app, { reason: "duplicate", duplicate_of: "sup-2" });
    expect(dup.body.resolution).toMatchObject({
      label: "Resolved by the team: Duplicate of SUP-2",
      duplicate_of: "SUP-2",
    });
    const other = await resolve(
      app,
      { reason: "other", note: "Moved to the vendor." },
      undefined,
      "SUP-1",
    );
    expect(other.status).toBe(409);
  });

  it("is refused to a team member who does not own it, to the customer, and to an agent", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-2/take");
    const notMine = await resolve(app, { reason: "wont_fix" }, teamActor, "SUP-2");
    expect([notMine.status, notMine.body.error.code]).toEqual([403, "not_owner"]);
    const customer = await resolve(app, { reason: "wont_fix" }, customerOne);
    expect(customer.status).toBe(403);
    // No tool offers it, so an assistant is never shown the action.
    expect(TOOL_ACTIONS.map((row) => row.name)).not.toContain("resolve_with_reason");
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("withdraws an open question to the customer, with a history entry saying so", async () => {
    const { app } = await setup();
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const asked = (await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask)).body;
    expect((await resolve(app, { reason: "fixed_no_reply" })).body.ready_at).toBeNull();
    const types = ((await admin(app).get("/api/tickets/SUP-1/events")).body as { type: string }[])
      .map((e) => e.type)
      .slice(-2);
    expect(types).toEqual(["question_withdrawn", "resolved_by_team"]);
    const late = await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: asked.ready_token });
    expect(late.status).toBe(409);
  });
});

describe("how a team resolution shows", () => {
  it("names the team and the reason to the customer on the page, in the list and in history", async () => {
    const { app } = await setup();
    await resolve(app, { reason: "wont_fix", note: "Works as designed." });
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    const card = page.querySelector(".ticket-card")!;
    expect(card.querySelector(".card-line")?.text.trim()).toBe(
      "Won't fix (Works as designed). You have not confirmed it.",
    );
    expect(card.querySelector("details#reopen summary")?.text).toBe("Still happening?");
    // The team reads the same reason on its card, with who and when, and not again by the status.
    const teamPage = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(teamPage.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Resolved by the team: Won't fix \(Works as designed\)\. Team Member, \d{1,2} [A-Z][a-z]{2} \d{4}\. The customer can reopen it\.$/,
    );
    expect(teamPage.querySelector(".ticket-facts")!.text).not.toContain("Won't fix");
    // The customer's line under the title says who resolved it, in plain words.
    expect(page.querySelector(".ticket-standing")?.text).toBe("Resolved by the team");
    // Never the tick or "Customer confirmed": the customer did not say so.
    expect(page.querySelector(".ticket-card .tick")).toBeNull();
    expect(page.querySelector("main")!.text).not.toContain("Customer confirmed");

    // In the list the status is one word, and the reason stays on the ticket's page.
    for (const who of [customerOne, teamActor]) {
      const list = parse((await as(app, who).get("/tickets?status=resolved")).text);
      expect(list.querySelector("table.tickets tbody td:nth-child(3)")?.text.trim()).toBe(
        "Resolved",
      );
    }
    const history = parse((await as(app, customerOne).get("/tickets/SUP-1")).text)
      .querySelectorAll("details.history tbody tr")
      .map((row) => row.querySelectorAll("td").map((td) => td.text.trim()));
    expect(history.at(-1)!.slice(1)).toEqual([
      "Resolved by the team: Won't fix (Works as designed.)",
      "Team Member team",
    ]);
  });

  it("says Customer confirmed only after the customer's Yes", async () => {
    const { app } = await setup();
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const asked = (await as(app, teamActor).post("/api/tickets/SUP-1/ready").send(ask)).body;
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/answer")
      .send({ fixed: "yes", ready_token: asked.ready_token });
    const ticket = (await as(app, customerOne).get("/api/tickets/SUP-1")).body;
    expect(ticket.resolution).toMatchObject({ by: "customer", label: "Customer confirmed" });
    const list = parse((await as(app, teamActor).get("/tickets?status=resolved")).text);
    const mark = list.querySelector("table.tickets .confirmed-mark");
    expect(mark?.getAttribute("aria-label")).toBe("Customer confirmed");
    expect(
      parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
        ".ticket-standing .tick",
      ),
    ).not.toBeNull();
  });

  it("can be reopened by the customer, which clears the team's resolution", async () => {
    const { app } = await setup();
    await resolve(app, { reason: "cannot_reproduce" });
    const reopened = await as(app, customerOne)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "It still jams on page two." });
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ status: "in_progress", resolution: null });
  });

  it("reaches an assistant's read as a label, without a visitor's note", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    // The seed records the sample's key, so no test names a fixed number for it.
    const sample = service.assistantSampleKey();
    const team = visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`);
    await team
      .post(`/api/tickets/${sample}/resolve`)
      .send({ reason: "wont_fix", note: "A visitor's words." });
    const page = parse((await visitor(built.app).post("/demo/connection")).text);
    const key = keyOnPage(page.toString());
    const read = await request(built.app)
      .get(`/api/tickets/${sample}`)
      .set("Authorization", `Bearer ${key}`);
    expect(read.body.resolution).toMatchObject({
      by: "team",
      label: "Resolved by the team: Won't fix",
      note: null,
    });
  });
});

describe("resolving with a reason on the page", () => {
  it("is a choice in the Status menu for the owner and admins, and its form takes the next step's place", async () => {
    const { app } = await setup();
    await admin(app).post("/api/tickets/SUP-2/take");
    const link = "a[href$='?step=resolve#resolve-form']";
    const owner = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    // The opener is the status itself, and the page's usual next step does not resolve.
    expect(owner.querySelector(`.status-menu ${link}`)?.text).toBe("Resolved");
    expect(owner.querySelector("form.resolve")).toBeNull();
    expect(owner.querySelector(".next-action")?.text).not.toContain("Resolve");
    // Chosen, the form shows where the next step was, with the page's one filled button.
    const shown = parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text);
    expect(shown.querySelector(".next-action")).toBeNull();
    const submit = shown.querySelector(".ticket-card form.resolve button[type=submit]")!;
    expect(submit.text).toBe("Resolve ticket");
    expect(submit.getAttribute("class")).toBeUndefined();
    expect(parse((await admin(app).get("/tickets/SUP-2")).text).querySelector(link)).not.toBeNull();
    expect(
      parse((await as(app, teamActor).get("/tickets/SUP-2")).text).querySelector(link),
    ).toBeNull();
    // Asking for the form in the address shows nothing to someone who may not resolve.
    expect(
      parse((await as(app, teamActor).get("/tickets/SUP-2?step=resolve")).text).querySelector(
        "form.resolve",
      ),
    ).toBeNull();
    expect(
      parse((await as(app, customerOne).get("/tickets/SUP-1?step=resolve")).text).querySelector(
        "form.resolve",
      ),
    ).toBeNull();
  });

  it("resolves from the form, and keeps what was typed when a note is missing", async () => {
    const { app } = await setup();
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "" });
    expect(refused.status).toBe(400);
    const form = parse(refused.text).querySelector("form.resolve")!;
    expect(form.querySelector("#resolve-error")?.text).toBe("Say why, for Other.");
    expect(form.querySelector("input[checked]")?.getAttribute("value")).toBe("other");
    const done = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "Moved to the vendor." });
    expect([done.status, done.headers.location]).toEqual([303, "/tickets/SUP-1"]);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.resolution.label).toBe(
      "Resolved by the team: Other",
    );
  });
});

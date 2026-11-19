import type { Express } from "express";
import { parse } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, type Actor } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { SIMILAR_LIMIT } from "../src/server/limits.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { keyOnPage } from "./key-on-page.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  teamActor,
} from "./helpers.js";

// The new ticket form asks POST /tickets/similar while a title is typed, and names at most one
// earlier ticket whose title holds at least two of the typed title's words and at least half of
// them, in any form. A customer is only ever shown a ticket they filed, and "nothing alike"
// reads the same whether or not another customer has a matching ticket.

const [demoCustomer, demoTeam, demoAdmin] = DEMO_ACTORS as [Actor, Actor, Actor];

/** A demo server with its sample tickets, as it starts. */
function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

/** The whole answer to one question, as the form's script reads it. */
async function ask(app: Express, who: Actor, title: string) {
  return as(app, who).post("/tickets/similar").type("form").send({ title });
}

/** The title the answer names, or null. */
async function similarTitle(app: Express, who: Actor, title: string): Promise<string | null> {
  const res = await ask(app, who, title);
  expect(res.status, title).toBe(200);
  return (res.body as { similar: { title: string } | null }).similar?.title ?? null;
}

async function file(app: Express, who: Actor, title: string): Promise<string> {
  const res = await as(app, who)
    .post("/api/tickets")
    .send({ title, description: "Seen this morning." });
  expect(res.status).toBe(201);
  return res.body.key as string;
}

describe("the similar ticket on the demo's sample tickets", () => {
  // Typed title, what the team is shown, what Demo Customer is shown. Demo Customer filed the
  // sign-in and password samples; another customer filed both checkout tickets.
  const cases: [string, string | null, string | null][] = [
    ["Can't sign in from my phone", "Cannot sign in on my phone", "Cannot sign in on my phone"],
    ["Signing in fails on phone", "Cannot sign in on my phone", "Cannot sign in on my phone"],
    [
      "Password reset not arriving",
      "Password reset email never arrives",
      "Password reset email never arrives",
    ],
    [
      "Reset my password please",
      "Password reset email never arrives",
      "Password reset email never arrives",
    ],
    ["Checkout adds tax twice", "The checkout total adds tax twice", null],
    ["Wrong currency on my invoice", null, null],
    ["The app is slow", null, null],
    ["It doesn't work", null, null],
    ["Printer is broken", null, null],
    ["The page is wrong", null, null],
    ["Sign up page", null, null],
    ["Cannot log in on mobile", null, null],
  ];

  it.each(cases)("%s", async (typed, forTeam, forCustomer) => {
    const { app } = buildDemo();
    expect(await similarTitle(app, demoTeam, typed)).toBe(forTeam);
    expect(await similarTitle(app, demoCustomer, typed)).toBe(forCustomer);
  });

  it("names the key, the title and the status as the list shows it", async () => {
    const { app } = buildDemo();
    const res = await ask(app, demoCustomer, "Can't sign in from my phone");
    expect(res.body).toEqual({
      similar: {
        key: expect.stringMatching(/^SUP-\d+$/),
        title: "Cannot sign in on my phone",
        status: "In Progress",
      },
    });
  });

  it("is not asked by the read-only admin preview", async () => {
    const { app } = buildDemo();
    const res = await ask(app, demoAdmin, "Can't sign in from my phone");
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("Cannot sign in on my phone");
  });
});

describe("what high overlap means", () => {
  it("needs two of the typed title's words, so one shared word names nothing", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Printer jams on the second page");
    expect(await similarTitle(app, customerOne, "Printer smells hot")).toBeNull();
    expect(await similarTitle(app, customerOne, "Printer jams")).toBe(
      "Printer jams on the second page",
    );
  });

  it("needs at least half of the typed title's words", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Printer jams on the second page");
    // Two of five words is under half.
    expect(
      await similarTitle(app, customerOne, "Printer jams during monthly invoice export"),
    ).toBeNull();
    // Three of five is at least half.
    expect(await similarTitle(app, customerOne, "Printer jams second sheet during export")).toBe(
      "Printer jams on the second page",
    );
  });

  it("names the ticket holding the most of the words, then an open one, then the newest", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Printer jams on paper");
    await file(app, customerOne, "Printer jams on thick paper today");
    await file(app, customerOne, "Printer jams");
    expect(await similarTitle(app, customerOne, "Printer jams on thick paper")).toBe(
      "Printer jams on thick paper today",
    );
    // Tied on two words: the newest of the open ones.
    expect(await similarTitle(app, customerOne, "Printer jams constantly")).toBe("Printer jams");
  });

  it("leaves out archived tickets", async () => {
    const { app } = buildTestApp();
    const key = await file(app, customerOne, "Printer jams on the second page");
    expect(await similarTitle(app, teamActor, "Printer jams again")).toBe(
      "Printer jams on the second page",
    );
    expect((await admin(app).post(`/api/tickets/${key}/archive`)).status).toBe(200);
    expect(await similarTitle(app, teamActor, "Printer jams again")).toBeNull();
  });

  it("names nothing for a title over 120 characters", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Printer jams on the second page");
    const long = `Printer jams ${"x".repeat(120)}`;
    expect(await similarTitle(app, customerOne, long)).toBeNull();
  });

  it("names nothing for a body without a title", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne).post("/tickets/similar").type("form").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ similar: null });
  });
});

describe("who may be shown what", () => {
  it("never names another customer's ticket, and says so in the same bytes as no match", async () => {
    const { app } = buildTestApp();
    const nothing = (await ask(app, customerOne, "Kettle boils over twice")).text;
    expect(nothing).toBe('{"similar":null}');
    const before = (await ask(app, customerOne, "Printer jams on the second page")).text;
    const key = await file(app, customerTwo, "Printer jams on the second page");
    // The other customer and the team are shown it.
    expect(await similarTitle(app, customerTwo, "Printer jams on the second page")).toBe(
      "Printer jams on the second page",
    );
    expect(await similarTitle(app, teamActor, "Printer jams on the second page")).toBe(
      "Printer jams on the second page",
    );
    const during = (await ask(app, customerOne, "Printer jams on the second page")).text;
    const gone = await admin(app).delete(`/api/tickets/${key}`).send({ confirm: key });
    expect(gone.body).toMatchObject({ deleted: true });
    const after = (await ask(app, customerOne, "Printer jams on the second page")).text;
    expect([before, during, after]).toEqual([nothing, nothing, nothing]);
  });

  it("is not answered to someone not signed in or to a connection key", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Printer jams on the second page");
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: ["read_tickets"] });
    const key = keyOnPage(res.text);
    const signedOut = await request(app)
      .post("/tickets/similar")
      .set(FROM_THIS_SITE)
      .type("form")
      .send({ title: "Printer jams on the second page" });
    const withKey = await request(app)
      .post("/tickets/similar")
      .set(FROM_THIS_SITE)
      .set("Authorization", `Bearer ${key}`)
      .type("form")
      .send({ title: "Printer jams on the second page" });
    // The pages send someone not signed in to the sign-in page, and do not read keys.
    for (const answer of [signedOut, withKey]) {
      expect(answer.status).toBe(303);
      expect(answer.headers.location).toMatch(/^\/sign-in/);
      expect(answer.text).not.toContain("Printer jams");
    }
  });

  it("is refused from another site", async () => {
    const { app } = buildTestApp();
    const res = await as(app, customerOne)
      .post("/tickets/similar")
      .set("Sec-Fetch-Site", "cross-site")
      .type("form")
      .send({ title: "Printer jams on the second page" });
    expect(res.status).toBe(403);
  });
});

describe("the question's own allowance", () => {
  it(`allows ${SIMILAR_LIMIT} questions per ten minutes, and does not count them as writes`, async () => {
    const { app } = buildTestApp();
    for (let n = 0; n < SIMILAR_LIMIT; n += 1) {
      expect((await ask(app, customerOne, "Printer jams on the second page")).status).toBe(200);
    }
    const over = await ask(app, customerOne, "Printer jams on the second page");
    expect(over.status).toBe(429);
    // The first write of this person still has all but itself of the write allowance left.
    const write = await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams on the second page", description: "Seen this morning." });
    expect(write.status).toBe(201);
    expect(write.headers["ratelimit"]).toContain('"120-in-10min"; r=119;');
  });
});

describe("the form's line", () => {
  it("is on the new ticket form, hidden, under the Title box", async () => {
    const { app } = buildTestApp();
    const form = await as(app, customerOne).get("/tickets/new").redirects(1);
    const page = parse(form.text);
    const box = page.querySelector('input[name="title"]')!;
    expect(box.getAttribute("data-similar-into")).toBe("title-similar");
    const line = page.querySelector("#title-similar")!;
    expect(line.tagName).toBe("SMALL");
    expect(line.hasAttribute("hidden")).toBe(true);
    expect(line.text).toBe("");
    expect(line.getAttribute("aria-live")).toBe("polite");
    expect(form.text).toContain('src="/assets/js/similar-ticket.js"');
  });

  it("is not on the edit form", async () => {
    const { app } = buildTestApp();
    const key = await file(app, customerOne, "Printer jams on the second page");
    const form = await as(app, customerOne).get(`/tickets/${key}/edit`);
    expect(form.status).toBe(200);
    expect(form.text).not.toContain("data-similar-into");
    expect(form.text).not.toContain('id="title-similar"');
  });
});

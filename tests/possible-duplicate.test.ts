import type { Express } from "express";
import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEMO_ACTORS, type Actor } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, customerTwo, teamActor } from "./helpers.js";

// On the team's page of a New or In Progress ticket, one quiet line names one other ticket that
// may report the same problem, found by the same word matching as the new ticket form's similar
// ticket. One press beside it resolves this ticket as a duplicate of that one. Customers never
// see the line, and the other ticket's title stays private from a customer who did not file it.

async function file(app: Express, who: Actor, title: string): Promise<string> {
  const res = await as(app, who)
    .post("/api/tickets")
    .send({ title, description: "Seen this morning." });
  expect(res.status).toBe(201);
  return res.body.key as string;
}

async function page(app: Express, who: Actor, key: string, query = ""): Promise<HTMLElement> {
  const res = await as(app, who).get(`/tickets/${key}${query}`);
  expect(res.status).toBe(200);
  return parse(res.text);
}

/** The line under the description, or null. */
function line(doc: HTMLElement): HTMLElement | null {
  return doc.querySelector("form.possible-duplicate");
}

/** The fields the line's one press sends, as the browser would send them. */
function fieldsOf(form: HTMLElement): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const input of form.querySelectorAll("input[type=hidden]")) {
    fields[input.getAttribute("name")!] = input.getAttribute("value") ?? "";
  }
  return fields;
}

/** The filled buttons a person can press in the page's main area. */
function filledButtons(doc: HTMLElement): string[] {
  const quiet = ["secondary", "outline", "link", "danger"];
  return doc
    .querySelectorAll("main :is(button, [role=button])")
    .filter((button) => !button.hasAttribute("disabled"))
    .filter((button) => !quiet.some((name) => button.classList.contains(name)))
    .map((button) => button.text.trim());
}

/** The visible headings in the page's main area. */
function visibleHeadings(doc: HTMLElement): string[] {
  return doc
    .querySelectorAll("main :is(h1, h2, h3)")
    .filter((heading) => !heading.classList.contains("visually-hidden"))
    .map((heading) => heading.text.trim());
}

describe("the possible duplicate line", () => {
  it("names the other ticket for the team, with one quiet press, and never for the customer", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Cannot sign in on my phone");
    const second = await file(app, customerOne, "Signing in fails on my phone");

    const found = line(await page(app, teamActor, second));
    expect(found).not.toBeNull();
    expect(found!.querySelector("p")!.text.replace(/\s+/g, " ").trim()).toBe(
      "Possible duplicate: SUP-1 Cannot sign in on my phone Close as a duplicate of SUP-1",
    );
    expect(found!.querySelector("a")!.getAttribute("href")).toBe("/tickets/SUP-1");
    // A quiet text button, so the page keeps its one black button.
    expect(found!.querySelector("button")!.classList.contains("link")).toBe(true);
    expect(fieldsOf(found!)).toMatchObject({ reason: "duplicate", duplicate_of: "SUP-1" });

    // The page keeps its one black button, the next step, and its one visible heading.
    const shown = await page(app, teamActor, second);
    expect(filledButtons(shown)).toEqual(["Take ticket and start work"]);
    expect(visibleHeadings(shown)).toEqual(["Signing in fails on my phone"]);

    // The customer filed both, and still sees no line.
    const theirs = await page(app, customerOne, second);
    expect(line(theirs)).toBeNull();
    expect(theirs.text).not.toContain("Possible duplicate");
  });

  it("names only an older ticket, so the original is never offered for closing", async () => {
    const { app } = buildTestApp();
    const original = await file(app, customerOne, "Cannot sign in on my phone");
    expect((await admin(app).post(`/api/tickets/${original}/take`)).status).toBe(200);
    const newer = await file(app, customerOne, "Cannot sign in on my phone after update");

    // The newer ticket names the original.
    expect(fieldsOf(line(await page(app, teamActor, newer))!).duplicate_of).toBe(original);
    // The original, already being worked on, shows no line naming the newer one.
    const originalPage = await page(app, teamActor, original);
    expect(line(originalPage)).toBeNull();
    expect(originalPage.querySelector(`main a[href="/tickets/${newer}"]`)).toBeNull();
  });

  it("shows nothing without a match, on a resolved ticket, or for the ticket alone", async () => {
    const { app } = buildTestApp();
    const alone = await file(app, customerOne, "Cannot sign in on my phone");
    // Its own title matches itself, and the line never names the ticket itself.
    expect(line(await page(app, teamActor, alone))).toBeNull();

    const other = await file(app, customerOne, "Printer jams on page two");
    expect(line(await page(app, teamActor, other))).toBeNull();

    const twin = await file(app, customerOne, "Signing in fails on my phone");
    expect(line(await page(app, teamActor, twin))).not.toBeNull();
    const resolved = await admin(app)
      .post(`/api/tickets/${twin}/resolve`)
      .send({ reason: "cannot_reproduce" });
    expect(resolved.status).toBe(200);
    expect(line(await page(app, teamActor, twin))).toBeNull();
  });

  it("never names a ticket already resolved as a duplicate, nor an archived one", async () => {
    const { app } = buildTestApp();
    const first = await file(app, customerOne, "Cannot sign in on my phone");
    const closed = await file(app, customerOne, "Cannot sign in on my phone today");
    const open = await file(app, customerOne, "Signing in fails on my phone");
    // The newest older match comes first, so before anything changes the open ticket names SUP-2.
    expect(fieldsOf(line(await page(app, teamActor, open))!).duplicate_of).toBe(closed);

    await admin(app)
      .post(`/api/tickets/${closed}/resolve`)
      .send({ reason: "duplicate", duplicate_of: first });
    expect(fieldsOf(line(await page(app, teamActor, open))!).duplicate_of).toBe(first);

    expect((await admin(app).post(`/api/tickets/${first}/archive`)).status).toBe(200);
    expect(line(await page(app, teamActor, open))).toBeNull();
  });

  it("resolves this ticket as a duplicate of the named one with one press, and leaves that one alone", async () => {
    const { app } = buildTestApp();
    const first = await file(app, customerOne, "Cannot sign in on my phone");
    const second = await file(app, customerOne, "Signing in fails on my phone");
    const firstBefore = (await admin(app).get(`/api/tickets/${first}`)).body;

    const team = as(app, teamActor);
    const shown = parse((await team.get(`/tickets/${second}`)).text);
    const pressed = await team
      .post(line(shown)!.getAttribute("action")!)
      .type("form")
      .send(fieldsOf(line(shown)!));
    expect(pressed.status).toBe(303);
    expect(pressed.headers.location).toBe(`/tickets/${second}`);
    // The usual one-time line after resolving with a reason.
    const after = await team.get(`/tickets/${second}`);
    expect(after.text).toContain("Resolved, with your reason.");

    const ticket = (await admin(app).get(`/api/tickets/${second}`)).body;
    expect(ticket.status).toBe("resolved");
    expect(ticket.resolution).toMatchObject({
      label: `Resolved by the team: Duplicate of ${first}`,
      duplicate_of: first,
    });
    const events = (await admin(app).get(`/api/tickets/${second}/events`)).body as {
      type: string;
    }[];
    expect(events.at(-1)?.type).toBe("resolved_by_team");
    // The other ticket is not changed.
    expect((await admin(app).get(`/api/tickets/${first}`)).body).toEqual(firstBefore);
  });

  it("is refused, and changes nothing, when the ticket changed after the page was opened", async () => {
    const { app } = buildTestApp();
    await file(app, customerOne, "Cannot sign in on my phone");
    const second = await file(app, customerOne, "Signing in fails on my phone");
    const shown = line(await page(app, teamActor, second))!;
    await admin(app).post(`/api/tickets/${second}/take`);

    const pressed = await as(app, teamActor)
      .post(shown.getAttribute("action")!)
      .type("form")
      .send(fieldsOf(shown));
    // Back to the ticket with the reason, as for any refused press.
    expect(pressed.headers.location).toBe(`/tickets/${second}`);
    expect((await admin(app).get(`/api/tickets/${second}`)).body.status).toBe("new");
  });

  it("prefills the resolve form's Duplicate of box with the match", async () => {
    const { app } = buildTestApp();
    const lone = await file(app, customerOne, "Printer jams on page two");
    await file(app, customerOne, "Cannot sign in on my phone");
    const second = await file(app, customerOne, "Signing in fails on my phone");

    const box = (doc: HTMLElement) =>
      doc.querySelector("#resolve-form input[name=duplicate_of]")!.getAttribute("value");
    expect(box(await page(app, teamActor, second, "?step=resolve"))).toBe("SUP-2");
    expect(box(await page(app, teamActor, lone, "?step=resolve"))).toBe("");
  });
});

describe("the customer of a ticket closed as a duplicate", () => {
  it("sees the other ticket's title nowhere, and a link to it only when they filed it too", async () => {
    const { app } = buildTestApp();
    const othersTicket = await file(app, customerTwo, "Cannot sign in on my phone");
    const ownTicket = await file(app, customerOne, "Signing in on my phone fails");
    const ownFirst = await file(app, customerOne, "Signing in fails again on my phone");
    const ownSecond = await file(app, customerOne, "Signing in still fails on my phone");

    await admin(app)
      .post(`/api/tickets/${ownTicket}/resolve`)
      .send({ reason: "duplicate", duplicate_of: othersTicket });
    await admin(app)
      .post(`/api/tickets/${ownSecond}/resolve`)
      .send({ reason: "duplicate", duplicate_of: ownFirst });

    // Another customer's ticket: the line says the reason as today, with no link and no title.
    const closed = await page(app, customerOne, ownTicket);
    expect(closed.querySelector(".card-line")!.text).toContain(
      `Duplicate of ${othersTicket}. You have not confirmed it.`,
    );
    expect(closed.querySelector(`a[href="/tickets/${othersTicket}"]`)).toBeNull();
    expect(closed.text).not.toContain("Cannot sign in on my phone");

    // Their own other ticket: its key is a link.
    const own = await page(app, customerOne, ownSecond);
    const link = own.querySelector(`.card-line a[href="/tickets/${ownFirst}"]`);
    expect(link?.text).toBe(`Open ${ownFirst}`);

    // The team always has the link.
    const team = await page(app, teamActor, ownTicket);
    expect(team.querySelector(`.card-line a[href="/tickets/${othersTicket}"]`)).not.toBeNull();
  });
});

describe("the possible duplicate line on the demo", () => {
  const [demoCustomer, demoTeam] = DEMO_ACTORS as [Actor, Actor];

  it("never shows on the demo's samples, which share words on purpose", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    const { app } = built;
    // The assistant's sample and the recorded run share most of their title's words.
    for (const key of [service.assistantSampleKey()!, service.recordedRunKey()!]) {
      expect(line(await page(app, demoTeam, key)), key).toBeNull();
    }
    // Every visitor files the same sample ticket; one visitor's is never offered as another's.
    const sample = {
      title: "The export button downloads an empty file",
      description:
        "When I export this month's report as CSV, the file has the header row and nothing else.",
    };
    await as(app, demoCustomer).post("/api/tickets").send(sample);
    const second = await as(app, demoCustomer).post("/api/tickets").send(sample);
    expect(second.status).toBe(201);
    expect(line(await page(app, demoTeam, second.body.key as string))).toBeNull();
    // A ticket of the visitor's own words still gets the line.
    const typed = await file(app, demoCustomer, "Export button gives an empty file");
    expect(line(await page(app, demoTeam, typed))).not.toBeNull();
  });

  it("names a real match even when a sample shares more words", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const { app } = built;
    const real = await file(app, demoCustomer, "Checkout total wrong after tax");
    // Both samples share more of this title's words than the real ticket does.
    const typed = await file(app, demoCustomer, "Checkout total adds tax twice again");
    expect(fieldsOf(line(await page(app, demoTeam, typed))!).duplicate_of).toBe(real);
  });
});

import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE, type Actor } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, teamActor, visitor } from "./helpers.js";

// The owner's next step on a ticket in progress marks it fixed and tells the customer. The ticket
// is resolved at once, and the customer's page asks "Did this fix it?": Yes confirms it, No sends
// it back to the team, who can mark it fixed again. Asking before resolving is under More options.

const valid = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

type Page = ReturnType<typeof parse>;

/** A ticket filed by the customer, taken and started by the team member. */
async function inProgress() {
  const { app } = buildTestApp();
  await as(app, customerOne).post("/api/tickets").send(valid);
  await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
  return app;
}

async function ticketPage(app: Express, who: Actor): Promise<Page> {
  return parse((await as(app, who).get("/tickets/SUP-1")).text);
}

/** Posts a page form as this person, then reads the saved line on the page it leads to. */
async function savedAfter(app: Express, who: Actor, path: string, fields: object) {
  const res = await as(app, who).post(path).type("form").send(fields);
  expect(res.status).toBe(303);
  const page = await visitor(app)
    .set("Cookie", [`${DEV_COOKIE}=${who.id}`, ...[res.headers["set-cookie"]].flat()])
    .get(res.headers.location!);
  return parse(page.text).querySelector("p.saved")?.text.trim();
}

/** The fields the next step's form sends, as the page draws them, with these boxes filled. */
function nextStepFields(page: Page, typed: Record<string, string> = {}) {
  const form = page.querySelector(".next-action form")!;
  const fields: Record<string, string> = {};
  for (const input of form.querySelectorAll("input")) {
    fields[input.getAttribute("name")!] = input.getAttribute("value") ?? "";
  }
  return { action: form.getAttribute("action")!, fields: { ...fields, ...typed } };
}

describe("Mark fixed and tell the customer", () => {
  it("is the owner's one step: one button, with no box above or beside it", async () => {
    const app = await inProgress();
    const page = await ticketPage(app, teamActor);
    const form = page.querySelector(".next-action form")!;
    expect(form.getAttribute("action")).toBe("/tickets/SUP-1/resolve");
    expect(form.querySelector("input[name=reason]")?.getAttribute("value")).toBe("fixed_no_reply");
    // Where it is fixed is given on the Status menu's Resolved form, never here.
    expect(form.querySelector("label")).toBeNull();
    expect(form.querySelectorAll("input:not([type=hidden])")).toHaveLength(0);
    expect(page.querySelector(".ticket-card")?.text).not.toContain("Fixed in");
    expect(form.querySelectorAll("button").map((b) => b.text)).toEqual([
      "Mark fixed and tell the customer",
    ]);
    // The reply box is a form of its own, so what is typed there is never sent by this press.
    expect(form.querySelector("textarea")).toBeNull();
  });

  it("resolves it with nothing typed, and says the customer has been told", async () => {
    const app = await inProgress();
    const { action, fields } = nextStepFields(await ticketPage(app, teamActor));
    expect(await savedAfter(app, teamActor, action, fields)).toBe(
      "Marked fixed. The customer has been told.",
    );
    const ticket = (await as(app, teamActor).get("/api/tickets/SUP-1")).body;
    expect(ticket.status).toBe("resolved");
    expect(ticket.resolution).toMatchObject({ by: "team", reason: "fixed_no_reply", note: null });
  });

  it("keeps where it is fixed, given on the Status menu's form, for both of them", async () => {
    const app = await inProgress();
    await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "fixed_no_reply", fixed_in: "version 4.2.1" })
      .expect(303);
    const team = await ticketPage(app, teamActor);
    expect(team.querySelector(".card-line")?.text).toContain("Fixed in: version 4.2.1.");
    const customer = await ticketPage(app, customerOne);
    expect(customer.querySelector("#did-this-fix-it")?.text).toContain("Fixed in: version 4.2.1");
  });

  it("shows a refusal beside its own button, and no reason form", async () => {
    const app = await inProgress();
    // The page sends no note from this button; the server still checks one sent by hand.
    const { action, fields } = nextStepFields(await ticketPage(app, teamActor), {
      note: "x".repeat(501),
    });
    const res = await as(app, teamActor).post(action).type("form").send(fields);
    expect(res.status).toBe(400);
    const page = parse(res.text);
    const step = page.querySelector(".next-action")!;
    expect(step.querySelector("#mark-fixed-error")?.text).toBe("Must be at most 500 characters.");
    expect(step.querySelector("button")?.getAttribute("aria-describedby")).toBe("mark-fixed-error");
    expect(page.querySelector("form.resolve")).toBeNull();
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.status).toBe("in_progress");
  });

  it("leaves asking first under More options, as Ask before resolving", async () => {
    const app = await inProgress();
    const page = await ticketPage(app, teamActor);
    const ask = page.querySelector("details.more-options details#ask")!;
    expect(ask.querySelector("summary")?.text).toBe("Ask before resolving");
    expect(ask.querySelector("textarea")?.hasAttribute("required")).toBe(false);
    expect(ask.querySelector("button")?.text).toBe("Ask the customer");
    // Pressed with nothing typed, it is the plain ask.
    await as(app, teamActor).post("/tickets/SUP-1/ready").type("form").send({}).expect(303);
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.waiting_on).toBe("customer");
  });
});

describe("the customer's answer to a ticket marked fixed", () => {
  async function markedFixed() {
    const app = await inProgress();
    const { action, fields } = nextStepFields(await ticketPage(app, teamActor));
    await as(app, teamActor).post(action).type("form").send(fields).expect(303);
    return app;
  }

  it("is Yes, which confirms it with the tick", async () => {
    const app = await markedFixed();
    const yes = (await ticketPage(app, customerOne)).querySelector(".card-answer > form")!;
    const version = yes.querySelector("input[name=expected_version]")!.getAttribute("value");
    expect(
      await savedAfter(app, customerOne, yes.getAttribute("action")!, {
        expected_version: version,
      }),
    ).toBe("Thank you. The ticket is resolved.");
    const page = await ticketPage(app, customerOne);
    expect(page.querySelector(".ticket-standing")?.text.trim()).toMatch(
      /^Resolved, customer confirmed on /,
    );
    expect(page.querySelector(".ticket-standing img.tick")).not.toBeNull();
    expect(page.querySelector("#did-this-fix-it")).toBeNull();
  });

  it("refuses a Yes from a page left open after the team reopened it", async () => {
    const app = await markedFixed();
    const yes = (await ticketPage(app, customerOne)).querySelector(".card-answer > form")!;
    const version = yes.querySelector("input[name=expected_version]")!.getAttribute("value");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "One more look." })
      .expect(200);
    await as(app, teamActor).post("/api/tickets/SUP-1/resolve").send({ reason: "fixed_no_reply" });
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/confirm")
      .type("form")
      .send({ expected_version: version });
    expect(res.status).toBe(303);
    const ticket = (await as(app, customerOne).get("/api/tickets/SUP-1")).body;
    expect(ticket.resolution).toMatchObject({ by: "team", reason: "fixed_no_reply" });
  });

  it("is No, which sends it back to the team, who can mark it fixed again", async () => {
    const app = await markedFixed();
    const no = (await ticketPage(app, customerOne)).querySelector("details.answer-no form")!;
    const version = no.querySelector("input[name=expected_version]")!.getAttribute("value");
    expect(
      await savedAfter(app, customerOne, no.getAttribute("action")!, {
        expected_version: version,
        reason: "Page two still jams.",
      }),
    ).toBe("Thank you. The ticket is back with the team.");
    const ticket = (await as(app, teamActor).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Team Member" });
    const team = await ticketPage(app, teamActor);
    expect(team.querySelector(".card-line")?.text.trim()).toMatch(
      /^The customer says it is not fixed, since /,
    );
    const again = nextStepFields(team);
    expect(team.querySelector(".next-action button")?.text).toBe(
      "Mark fixed and tell the customer",
    );
    await as(app, teamActor).post(again.action).type("form").send(again.fields).expect(303);
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.status).toBe("resolved");
  });

  it("keeps No open with its message and focus after an empty try", async () => {
    const app = await markedFixed();
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/reopen")
      .type("form")
      .send({ reason: "" });
    expect(res.status).toBe(400);
    const no = parse(res.text).querySelector("#did-this-fix-it details.answer-no")!;
    expect(no.hasAttribute("open")).toBe(true);
    expect(no.querySelector("#answer-error")?.text).not.toBe("");
    expect(no.querySelector("textarea[name=reason]")?.hasAttribute("autofocus")).toBe(true);
  });

  it("is the same card when the team asked first, with the same two labels", async () => {
    const app = await inProgress();
    await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({}).expect(200);
    const card = (await ticketPage(app, customerOne)).querySelector("#did-this-fix-it")!;
    expect(card.querySelector(".card-answer > form button")?.text).toBe("Yes, it is fixed");
    expect(card.querySelector("details.answer-no summary")?.text).toBe("No, it is not fixed");
    expect(card.querySelector(".card-answer > form")?.getAttribute("action")).toBe(
      "/tickets/SUP-1/answer",
    );
    const mine = parse((await as(app, customerOne).get("/tickets")).text);
    expect(mine.querySelector("a.turn-tag")?.text).toBe("Did this fix it?");
  });
});

describe("the Status menu's Resolved form", () => {
  async function resolveForm(app: Express) {
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text);
    return page.querySelector("form.resolve")!;
  }

  it("has the box Fixed in for Fixed, and one button label for every reason", async () => {
    const app = await inProgress();
    const form = await resolveForm(app);
    const label = form.querySelector("label.resolve-fixed-in")!;
    expect(label.text.trim()).toBe("Fixed in (optional)");
    expect(label.querySelector("input")?.getAttribute("name")).toBe("fixed_in");
    // "Why?" keeps its own box, for Other.
    expect(form.querySelector("label.resolve-note")?.text.trim()).toBe("Why?");
    // The Fixed choice says itself that the customer is told, so the button never changes.
    const fixed = form.querySelector("input[value=fixed_no_reply]")!.parentNode!;
    expect(fixed.text.trim()).toBe("Fixed (the customer is told)");
    const button = form.querySelector(".form-actions button")!;
    expect(button.text).toBe("Resolve ticket");
    expect(button.hasAttribute("data-label-fixed")).toBe(false);
  });

  it("sends only the box for the reason chosen", async () => {
    const app = await inProgress();
    const send = (fields: object) =>
      as(app, teamActor).post("/tickets/SUP-1/resolve").type("form").send(fields).expect(303);
    await send({ reason: "fixed_no_reply", fixed_in: "live now", note: "Left in Why?" });
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.resolution.note).toBe(
      "live now",
    );
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Again." })
      .expect(200);
    await send({ reason: "other", fixed_in: "Left in Fixed in", note: "A one-off." });
    expect((await as(app, teamActor).get("/api/tickets/SUP-1")).body.resolution.note).toBe(
      "A one-off.",
    );
  });
});

describe("the demo's seat change on a ticket marked fixed", () => {
  it("offers the team the customer's view, until the customer confirms it", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const asDemo = (id: string) =>
      visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`).set(FROM_THIS_SITE);
    await asDemo("demo-team").post("/tickets/SUP-4/take-and-start");
    await asDemo("demo-team")
      .post("/tickets/SUP-4/resolve")
      .type("form")
      .send({ reason: "fixed_no_reply", from: "next-step" })
      .expect(303);
    const seat = async () =>
      parse((await asDemo("demo-team").get("/tickets/SUP-4")).text)
        .querySelector(".demo-next button")
        ?.text.trim() ?? null;
    expect(await seat()).toBe("View this ticket as the customer who filed it");
    await asDemo("demo-customer").post("/tickets/SUP-4/confirm").type("form").send({}).expect(303);
    expect(await seat()).toBeNull();
  });
});

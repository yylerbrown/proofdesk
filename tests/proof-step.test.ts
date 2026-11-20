import type { Express } from "express";
import { parse, type HTMLElement } from "node-html-parser";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { SAMPLE_PROOFS } from "../src/server/pages/proof-step.js";
import { createTicketSchema } from "../src/server/tickets/schemas.js";
import { keyOnPage } from "./key-on-page.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  customerTwo,
  FROM_THIS_SITE,
  teamActor,
  visitor,
} from "./helpers.js";

// Saying what would prove it is fixed is the second step of filing. The new ticket form asks
// for the title and the description; filing opens the ticket on a small step, in the place the
// check takes once saved, with one box, Save and a quiet "Skip for now". Suggested ways fill the
// box. Afterwards the check is quoted under the description, its filer may change it, and a
// ticket without one shows its filer one quiet link to add it.

const noCheck = { title: "Export is empty", description: "The monthly export has no rows." };

/** The filled buttons in the page's main area: every button not drawn as outlined or a link. */
function filledButtons(page: HTMLElement): string[] {
  const quiet = ["secondary", "outline", "link", "danger"];
  return page
    .querySelectorAll("main :is(button, [role=button])")
    .filter((button) => !quiet.some((name) => button.classList.contains(name)))
    .map((button) => button.text.trim());
}

/** The visible headings in the page's main area. */
function visibleHeadings(page: HTMLElement): string[] {
  return page
    .querySelectorAll("main :is(h1, h2, h3)")
    .filter((heading) => !heading.classList.contains("visually-hidden"))
    .map((heading) => heading.text.trim());
}

/** The step's controls a keyboard reaches, in order. */
function stepControls(page: HTMLElement): string[] {
  return page
    .querySelectorAll("form#verify-form :is(input:not([type=hidden]), textarea, button, a)")
    .map((control) => control.getAttribute("name") ?? control.text.trim());
}

async function fileOnPage(app: Express) {
  const browser = as(app, customerOne);
  const filed = await browser.post("/tickets").type("form").send(noCheck);
  return { browser, filed };
}

async function page(app: Express, who: typeof customerOne, address: string) {
  return parse((await as(app, who).get(address)).text);
}

/** An admin issues a connection that may suggest, and it offers these ways on SUP-1. */
async function offer(app: Express, options: string[]) {
  const issued = await admin(app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: ["read_tickets", "suggest_when_asked", "suggest_automatic"] });
  const key = keyOnPage(issued.text);
  const res = await request(app)
    .post("/api/tickets/SUP-1/check-suggestions")
    .set("Authorization", `Bearer ${key}`)
    .send({ options });
  expect(res.status, res.text).toBe(201);
  return res.body.suggestions as { id: number; words: string }[];
}

describe("filing", () => {
  it("opens a ticket that does not say what would prove it on the step that asks", async () => {
    const { app } = buildTestApp();
    const { filed } = await fileOnPage(app);
    expect(filed.status).toBe(303);
    expect(filed.headers.location).toBe("/tickets/SUP-1?step=verify");
  });

  it("opens a ticket a hand-made form filed with a check on the ticket itself", async () => {
    const { app } = buildTestApp();
    const filed = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ ...noCheck, fix_check: "Every row is there" });
    expect(filed.headers.location).toBe("/tickets/SUP-1");
    expect((await as(app, customerOne).get("/api/tickets/SUP-1")).body.fix_check).toBe(
      "Every row is there",
    );
  });

  it("does not file again when the same form is sent after its check was saved", async () => {
    const { app } = buildTestApp();
    const browser = as(app, customerOne);
    // A form id as the new ticket form makes one: 16 random bytes, base64url.
    const form = { ...noCheck, form: "a".repeat(22) };
    await browser.post("/tickets").type("form").send(form);
    await browser.post("/tickets/SUP-1/check").type("form").send({ words: "Every row" });
    const again = await browser.post("/tickets").type("form").send(form);
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe("/tickets/SUP-1");
    expect((await browser.get("/api/tickets")).body).toHaveLength(1);
  });
});

describe("the step", () => {
  it("is the label, one grey line, one box, Save and Skip for now, for the filer", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    const html = parse((await browser.get("/tickets/SUP-1?step=verify")).text);
    const step = html.querySelector(".ticket-card form#verify-form")!;
    expect(step.getAttribute("action")).toBe("/tickets/SUP-1/check");
    expect(step.querySelector("input[name=expected_version]")?.getAttribute("value")).toBe("1");
    expect(step.querySelector("label")?.text).toBe("What would prove it is fixed?");
    // The second sentence is made true by the list's default order.
    expect(step.querySelectorAll("p.hint").map((line) => line.text)).toEqual([
      "One thing you can check yourself when the team says it is fixed. Tickets that say what would prove it is fixed are listed first for the team.",
    ]);
    expect(stepControls(html)).toEqual(["words", "Save", "Skip for now"]);
    // The box stops where the server does.
    expect(Number(step.querySelector("textarea")?.getAttribute("maxlength"))).toBe(
      createTicketSchema.shape.fix_check.unwrap().maxLength,
    );
    expect(step.querySelector(".form-actions a")?.getAttribute("href")).toBe("/tickets/SUP-1");
    // Save is the page's one black button, and the title its one visible heading.
    expect(filledButtons(html)).toEqual(["Save"]);
    expect(visibleHeadings(html)).toEqual([noCheck.title]);
    // With nothing suggested and nothing listening, not a word about an assistant.
    expect(step.querySelector(".proof-choices")?.getAttribute("hidden")).not.toBeUndefined();
    expect(html.querySelector("main")!.text).not.toMatch(/assistant/i);
  });

  it("says the page may ask an assistant only on a New ticket off the demo", async () => {
    const { app } = buildTestApp();
    await fileOnPage(app);
    const html = await page(app, customerOne, "/tickets/SUP-1?step=verify");
    const step = html.querySelector("form#verify-form")!;
    expect(step.getAttribute("data-proof-read")).toBe("/tickets/SUP-1/check-suggestions");
    expect(step.getAttribute("data-proof-ask")).toBe("/tickets/SUP-1/check-suggestions/request");
  });

  it("is not shown to the team, and another customer cannot open the ticket", async () => {
    const { app } = buildTestApp();
    await fileOnPage(app);
    const team = await page(app, teamActor, "/tickets/SUP-1?step=verify");
    expect(team.querySelector("form#verify-form")).toBeNull();
    // Until the customer saves, the team sees no label.
    expect(team.querySelector("main")!.text).not.toContain("What would prove it is fixed?");
    expect(team.querySelector("main")!.text).not.toContain("Add what would prove it");
    const other = await as(app, customerTwo).get("/tickets/SUP-1?step=verify");
    expect(other.status).toBe(404);
  });

  it("is not offered once the ticket is resolved", async () => {
    const { app } = buildTestApp();
    await fileOnPage(app);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "cannot_reproduce" });
    const html = await page(app, customerOne, "/tickets/SUP-1?step=verify");
    expect(html.querySelector("form#verify-form")).toBeNull();
    expect(html.querySelector("main")!.text).not.toContain("Add what would prove it");
  });
});

describe("the promise in the step's grey line", () => {
  it("holds: a ticket saved with what would prove it comes first in the team's list", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    await browser.post("/tickets").type("form").send({ title: "Fax is slow", description: "x" });
    await browser.post("/tickets/SUP-1/check").type("form").send({ words: "Every row" });
    const keys = (await as(app, teamActor).get("/api/tickets")).body.map(
      (ticket: { key: string }) => ticket.key,
    );
    expect(keys.indexOf("SUP-1")).toBeLessThan(keys.indexOf("SUP-2"));
  });
});

describe("Save, Skip, Change and Add", () => {
  it("saves the box and quotes it under the description, saying so once", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    const saved = await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({ words: "Every row is in the file", expected_version: "1" });
    expect(saved.status).toBe(303);
    expect(saved.headers.location).toBe("/tickets/SUP-1");
    const html = parse((await browser.get("/tickets/SUP-1")).text);
    const card = html.querySelector(".ticket-card")!;
    expect(card.querySelector(".card-label")?.childNodes[0]?.text.trim()).toBe(
      "What would prove it is fixed?",
    );
    expect(card.querySelector("blockquote")?.text).toBe("Every row is in the file");
    expect(card.querySelector(".card-saved")?.text).toBe(
      "Saved. The team will check the fix against it.",
    );
    // Said in the card, so not again at the top of the page.
    expect(html.querySelector("p.saved")).toBeNull();
    const later = parse((await browser.get("/tickets/SUP-1")).text);
    expect(later.querySelector(".card-saved")).toBeNull();
  });

  it("gives the filer a quiet Change that opens the step with the words in the box", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    await browser.post("/tickets/SUP-1/check").type("form").send({ words: "Every row" });
    const html = parse((await browser.get("/tickets/SUP-1")).text);
    const change = html.querySelector(".ticket-card .card-label a")!;
    expect(change.text).toBe("Change");
    expect(change.getAttribute("href")).toBe("/tickets/SUP-1?step=verify#verify-form");
    const step = parse((await browser.get("/tickets/SUP-1?step=verify")).text);
    expect(step.querySelector("form#verify-form textarea")?.text).toBe("Every row");
    // A saved check is quoted once: in the box while the step shows.
    expect(step.querySelector(".ticket-card blockquote")).toBeNull();
    expect(step.querySelector("form#verify-form .form-actions a")?.text).toBe("Cancel");
    // The team never gets the Change.
    const team = await page(app, teamActor, "/tickets/SUP-1");
    expect(team.querySelector(".ticket-card .card-label")?.text.trim()).toBe(
      "What would prove it is fixed?",
    );
    const changed = await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({ words: "Every row, in order", expected_version: "2" });
    expect(changed.status).toBe(303);
    const history = parse((await browser.get("/tickets/SUP-1")).text)
      .querySelector("details.history")!
      .text.replace(/\s+/g, " ");
    expect(history).toContain("Customer wrote what would prove it is fixed");
    expect(history).toContain("Customer changed what would prove it is fixed");
  });

  it("after Skip for now, shows the filer one quiet link to add it, and the team nothing", async () => {
    const { app } = buildTestApp();
    await fileOnPage(app);
    const html = await page(app, customerOne, "/tickets/SUP-1");
    const add = html.querySelector(".ticket-card .card-proof-add a")!;
    expect(add.text).toBe("Add what would prove it");
    expect(add.getAttribute("href")).toBe("/tickets/SUP-1?step=verify#verify-form");
    expect(html.querySelector("form#verify-form")).toBeNull();
    const team = await page(app, teamActor, "/tickets/SUP-1");
    expect(team.querySelector(".card-proof-add")).toBeNull();
  });

  it("shows the step again with the words kept when the ticket changed meanwhile", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    // The team takes it while the customer is writing.
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const refused = await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({ words: "Every row is there", expected_version: "1" });
    expect(refused.status).toBe(409);
    const html = parse(refused.text);
    const step = html.querySelector("form#verify-form")!;
    expect(step.querySelector("textarea")?.text).toBe("Every row is there");
    expect(step.querySelector("textarea")?.hasAttribute("autofocus")).toBe(true);
    expect(step.querySelector("#proof-error")?.text).toContain("What you wrote is kept here.");
    const fresh = step.querySelector("input[name=expected_version]")?.getAttribute("value");
    expect(fresh).not.toBe("1");
    const again = await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({ words: "Every row is there", expected_version: fresh });
    expect(again.status).toBe(303);
  });

  it("sends an empty box back to the step with the reason", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    const refused = await browser.post("/tickets/SUP-1/check").type("form").send({ words: "" });
    expect(refused.status).toBe(303);
    expect(refused.headers.location).toBe("/tickets/SUP-1?step=verify#verify-form");
  });
});

describe("suggested ways", () => {
  it("fill the step with up to three pick-one choices under one grey line", async () => {
    const { app } = buildTestApp();
    await fileOnPage(app);
    const offered = await offer(app, ["Every row is there", "The file opens", "It has a total"]);
    const html = await page(app, customerOne, "/tickets/SUP-1?step=verify");
    const choices = html.querySelector("form#verify-form .proof-choices")!;
    expect(choices.getAttribute("hidden")).toBeUndefined();
    expect(choices.querySelector("legend")?.text).toBe(
      "Suggested by the team's AI assistant. Pick one to fill the box, then edit it if you like.",
    );
    const radios = choices.querySelectorAll("input[type=radio]");
    expect(radios.map((radio) => radio.getAttribute("name"))).toEqual([
      "suggestion_id",
      "suggestion_id",
      "suggestion_id",
    ]);
    expect(radios.map((radio) => radio.getAttribute("value"))).toEqual(
      offered.map((suggestion) => String(suggestion.id)),
    );
    expect(radios.map((radio) => radio.getAttribute("data-words"))).toEqual(
      offered.map((suggestion) => suggestion.words),
    );
    // Nothing is picked and the box is empty until the customer picks.
    expect(radios.some((radio) => radio.hasAttribute("checked"))).toBe(false);
    expect(html.querySelector("form#verify-form textarea")?.text).toBe("");
    expect(choices.text).not.toContain("Something else");
    // The choices come before the box, then Save and Skip.
    expect(stepControls(html)).toEqual([
      "suggestion_id",
      "suggestion_id",
      "suggestion_id",
      "words",
      "Save",
      "Skip for now",
    ]);
  });

  it("post by id: with scripts off an empty box takes the picked choice's words", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    const offered = await offer(app, ["Every row is there", "The file opens"]);
    const saved = await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({ suggestion_id: String(offered[1]!.id), words: "", expected_version: "1" });
    expect(saved.status).toBe(303);
    const ticket = (await browser.get("/api/tickets/SUP-1")).body;
    expect(ticket.fix_check).toBe("The file opens");
    expect(ticket.check_suggestions[1].state).toBe("chosen");
  });

  it("post by id with the box's own words, which are what is saved", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    const offered = await offer(app, ["Every row is there"]);
    await browser
      .post("/tickets/SUP-1/check")
      .type("form")
      .send({
        suggestion_id: String(offered[0]!.id),
        words: "Every row is there, in date order",
        expected_version: "1",
      });
    expect((await browser.get("/api/tickets/SUP-1")).body.fix_check).toBe(
      "Every row is there, in date order",
    );
  });

  it("show the team only one grey line saying they wait, never the words", async () => {
    const { app } = buildTestApp();
    await fileOnPage(app);
    await offer(app, ["Every row is there", "The file opens", "It has a total"]);
    const html = await page(app, teamActor, "/tickets/SUP-1");
    expect(html.querySelector(".ticket-card .card-waiting")?.text).toBe(
      "The assistant suggested 3 ways to prove it. The customer has not picked one.",
    );
    const main = html.querySelector("main")!;
    expect(main.querySelector("input[type=radio][name=suggestion_id]")).toBeNull();
    expect(main.text).not.toContain("Every row is there");
    expect(main.text).not.toContain("What would prove it is fixed?");
  });

  it("say one way in the singular, and nothing once the customer saved", async () => {
    const { app } = buildTestApp();
    const { browser } = await fileOnPage(app);
    await offer(app, ["Every row is there"]);
    const before = await page(app, teamActor, "/tickets/SUP-1");
    expect(before.querySelector(".card-waiting")?.text).toBe(
      "The assistant suggested 1 way to prove it. The customer has not picked one.",
    );
    await browser.post("/tickets/SUP-1/check").type("form").send({ words: "My own words" });
    const after = await page(app, teamActor, "/tickets/SUP-1");
    expect(after.querySelector(".card-waiting")).toBeNull();
    expect(after.querySelector(".ticket-card blockquote")?.text).toBe("My own words");
  });
});

describe("the edit form", () => {
  it("keeps the check when the filer saves it, since it has no box for it", async () => {
    const { app } = buildTestApp();
    const browser = as(app, customerOne);
    await browser.post("/api/tickets").send({ ...noCheck, fix_check: "Every row" });
    const saved = await browser
      .post("/tickets/SUP-1/edit")
      .type("form")
      .send({ ...noCheck, title: "Export is empty again", expected_version: "1" });
    expect(saved.status).toBe(303);
    const ticket = (await browser.get("/api/tickets/SUP-1")).body;
    expect(ticket.title).toBe("Export is empty again");
    expect(ticket.fix_check).toBe("Every row");
  });
});

describe("the demo's sample", () => {
  function demo() {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const browser = visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-customer`);
    return { ...built, browser };
  }

  /** Files the welcome card's sample as it is, and says where it lands. */
  async function fileSample(browser: ReturnType<typeof visitor>) {
    const form = parse((await browser.get("/tickets/new?try=1").redirects(1)).text);
    const fields = Object.fromEntries(
      form
        .querySelectorAll("main form input[type=hidden], main form input[name=title]")
        .map((input) => [input.getAttribute("name")!, input.getAttribute("value") ?? ""]),
    );
    fields.description = form.querySelector("main form textarea[name=description]")!.text;
    const filed = await browser.post("/tickets").type("form").send(fields);
    return filed.headers.location as string;
  }

  it("lands on the step with three sample choices, the first already in the box", async () => {
    const { browser } = demo();
    const landed = await fileSample(browser);
    expect(landed).toMatch(/^\/tickets\/SUP-\d+\?step=verify$/);
    const html = parse((await browser.get(landed)).text);
    const step = html.querySelector("form#verify-form")!;
    expect(step.querySelector("legend")?.text).toBe(
      "Sample suggestions. On a real site the team's own AI assistant writes these.",
    );
    const radios = step.querySelectorAll("input[type=radio]");
    expect(radios.map((radio) => radio.getAttribute("data-words"))).toEqual([...SAMPLE_PROOFS]);
    expect(radios.map((radio) => radio.getAttribute("name"))).toEqual([
      "sample_choice",
      "sample_choice",
      "sample_choice",
    ]);
    expect(radios.map((radio) => radio.hasAttribute("checked"))).toEqual([true, false, false]);
    expect(step.querySelector("textarea")?.text).toBe(SAMPLE_PROOFS[0]);
    // The page never asks an assistant on the demo, and nothing else shows the choices.
    expect(step.getAttribute("data-proof-ask")).toBeUndefined();
    // While the step shows, Save is the one thing to press: the change of seat waits.
    expect(html.querySelector(".demo-next")).toBeNull();
    expect(filledButtons(html)).toEqual(["Save"]);
  });

  it("with scripts off and the box emptied, saves the sample choice picked", async () => {
    const { browser } = demo();
    const landed = await fileSample(browser);
    const key = /SUP-\d+/.exec(landed)![0];
    await browser
      .post(`/tickets/${key}/check`)
      .type("form")
      .send({ sample_choice: "2", words: "", expected_version: "1" });
    expect((await browser.get(`/api/tickets/${key}`)).body.fix_check).toBe(SAMPLE_PROOFS[2]);
  });

  it("offers no sample choices on a ticket that is not the sample", async () => {
    const { browser } = demo();
    const filed = await browser
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "It jams on page two." });
    const html = parse((await browser.get(filed.headers.location as string)).text);
    expect(html.querySelector("form#verify-form")).not.toBeNull();
    expect(html.querySelector("form#verify-form input[type=radio]")).toBeNull();
    expect(html.querySelector("main")!.text).not.toMatch(/assistant/i);
  });
});

describe("the guided path on the demo", () => {
  it("is eight presses, from the welcome card to the customer's Yes", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const { app } = built;
    let seat = "demo-customer";
    const browser = () =>
      request.agent(app).set(FROM_THIS_SITE).set("Cookie", `${DEV_COOKIE}=${seat}`);
    const pressed: string[] = [];

    /** Presses the button with these words in a form on the page, and follows where it leads. */
    async function press(html: HTMLElement, words: string): Promise<string> {
      const button = html
        .querySelectorAll("main form button")
        .find((candidate) => candidate.text.trim() === words);
      expect(button, words).toBeDefined();
      // The form the button sits in.
      const form = html
        .querySelectorAll("main form")
        .find((candidate) => candidate.querySelectorAll("button").includes(button!))!;
      const fields: Record<string, string> = {};
      for (const input of form.querySelectorAll("input[name]")) {
        const type = input.getAttribute("type");
        if ((type === "radio" || type === "checkbox") && !input.hasAttribute("checked")) continue;
        fields[input.getAttribute("name")!] = input.getAttribute("value") ?? "";
      }
      for (const box of form.querySelectorAll("textarea[name]")) {
        fields[box.getAttribute("name")!] = box.text;
      }
      pressed.push(words);
      const res = await browser().post(form.getAttribute("action")!).type("form").send(fields);
      expect(res.status, words).toBe(303);
      if (fields.id !== undefined && form.getAttribute("action") === "/sign-in/dev") {
        seat = fields.id;
      }
      return res.headers.location as string;
    }
    const open = async (address: string) => parse((await browser().get(address).redirects(1)).text);

    const list = await open("/tickets");
    const start = list.querySelector(".demo-welcome [role=button]")!;
    pressed.push(start.text.trim());
    let at = await press(await open(start.getAttribute("href")!), "File ticket");
    at = await press(await open(at), "Save");
    at = await press(await open(at), "View this ticket as a team member");
    at = await press(await open(at), "Take ticket and start work");
    at = await press(await open(at), "Mark fixed and tell the customer");
    at = await press(await open(at), "View this ticket as the customer who filed it");
    at = await press(await open(at), "Yes, it is fixed");
    expect(pressed).toEqual([
      "File a sample ticket",
      "File ticket",
      "Save",
      "View this ticket as a team member",
      "Take ticket and start work",
      "Mark fixed and tell the customer",
      "View this ticket as the customer who filed it",
      "Yes, it is fixed",
    ]);
    const key = /SUP-\d+/.exec(at)![0];
    const ticket = (await browser().get(`/api/tickets/${key}`)).body;
    expect(ticket.status).toBe("resolved");
    expect(ticket.fix_check).toBe(SAMPLE_PROOFS[0]);
    // "Did this fix it?" quoted the saved words, as the resolved page still does.
    const resolved = await open(`/tickets/${key}`);
    expect(resolved.querySelector(".ticket-card blockquote")?.text).toBe(SAMPLE_PROOFS[0]);
  });
});

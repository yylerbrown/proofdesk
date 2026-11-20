import { parse, type HTMLElement } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, teamActor, visitor } from "./helpers.js";

// One part of the ticket's single column, under the description, holds the customer's check, the
// one line saying where the ticket stands, and the one step this person can take, as plain lines
// with no box. It is the same in every state and for both roles; the blocks that used to stand
// apart (the next step, the customer's No, the confirmation, the team's resolution, the demo's
// change of seat) are lines and steps inside it.

function buildDemo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  const service = createTicketService(built.db, built.config.ticketPrefix);
  seedDemo(service);
  return { ...built, service };
}

const asDemo = (app: Express, id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);

async function ticketPage(app: Express, id: string, key: string) {
  const res = await asDemo(app, id).get(`/tickets/${key}`);
  expect(res.status).toBe(200);
  return parse(res.text);
}

/** The seven states the design review draws, each as its viewer sees it on the demo. */
async function everyState() {
  const { app, service } = buildDemo();
  const pages: [string, HTMLElement][] = [];
  const team = (key: string) => ticketPage(app, "demo-team", key);
  pages.push(["customer, their own New ticket", await ticketPage(app, "demo-customer", "SUP-5")]);
  pages.push(["team, New with no owner", await team("SUP-8")]);
  pages.push(["team, In Progress after the customer's No", await team("SUP-7")]);
  pages.push(["team, Resolved by the customer", await team("SUP-6")]);
  pages.push(["team, the ticket an assistant worked", await team(service.recordedRunKey()!)]);
  await asDemo(app, "demo-team")
    .post("/tickets/SUP-3/ready")
    .set(FROM_THIS_SITE)
    .type("form")
    .send({})
    .expect(303);
  pages.push(["team, waiting on the customer", await team("SUP-3")]);
  pages.push(["customer, asked Did this fix it?", await ticketPage(app, "demo-customer", "SUP-3")]);
  return Object.fromEntries(pages);
}

/** The card's parts in order, by what each one is. */
function parts(card: HTMLElement): string[] {
  return card.childNodes
    .filter((node): node is HTMLElement => node instanceof Object && "tagName" in node)
    .map((el) => {
      if (el.tagName === "H2") return "question";
      if (el.classList.contains("card-label")) return "label";
      if (el.tagName === "BLOCKQUOTE") return "check";
      if (el.classList.contains("card-line")) return "line";
      if (el.classList.contains("card-answer")) return "answer";
      if (el.classList.contains("card-step")) return "step";
      return el.classList.toString() || el.tagName.toLowerCase();
    });
}

describe("the ticket's card", () => {
  it("is one card under the description in every state, holding check, line and step in order", async () => {
    const states = await everyState();
    const expected: Record<string, string[]> = {
      "customer, their own New ticket": ["label", "check", "step"],
      "team, New with no owner": ["label", "check", "step"],
      // While the step is "Mark fixed and tell the customer", it says the check once, above
      // its button, since the press agrees the check was met.
      "team, In Progress after the customer's No": ["line", "step"],
      "team, Resolved by the customer": ["label", "check", "line"],
      // The assistant's suggested test waits for review, so its card comes before the step.
      "team, the ticket an assistant worked": ["assistant-card", "step"],
      "team, waiting on the customer": ["label", "check", "line", "step"],
      "customer, asked Did this fix it?": ["question", "check", "answer"],
    };
    for (const [state, page] of Object.entries(states)) {
      const cards = page.querySelectorAll("main .ticket-card");
      expect(cards, state).toHaveLength(1);
      const card = cards[0]!;
      expect(card.parentNode?.classList.contains("ticket-page"), state).toBe(true);
      expect(parts(card), state).toEqual(expected[state]);
      // The line under the title holds the status and the owner, and never the check.
      const top = page.querySelector(".ticket-facts, .ticket-standing")!;
      expect(top.querySelector("blockquote"), state).toBeNull();
      expect(top.text, state).not.toContain("What would prove it");
    }
  });

  it("leaves no block of its own for the step, the No, the confirmation or the seat change", async () => {
    const states = await everyState();
    for (const [state, page] of Object.entries(states)) {
      for (const gone of [
        "#customer-said-no",
        "article.confirmed",
        "article.resolved-by-team",
        ".waiting-line",
      ]) {
        expect(page.querySelector(gone), `${state}: ${gone}`).toBeNull();
      }
      for (const step of page.querySelectorAll("main .next-action, main .demo-next")) {
        expect(step.closest(".ticket-card"), state).not.toBeNull();
      }
      // The tick only ever stands beside the words "Customer confirmed".
      for (const tick of page.querySelectorAll("main .tick")) {
        expect(tick.parentNode?.text, state).toContain("Customer confirmed on ");
      }
    }
    expect(states["team, Resolved by the customer"]!.querySelectorAll("main .tick")).toHaveLength(
      1,
    );
  });

  it("comes after status and owner in the page, so the keyboard reaches them first", async () => {
    const states = await everyState();
    for (const [state, page] of Object.entries(states)) {
      const html = page.querySelector(".ticket-page")!.toString();
      const top = Math.max(
        html.indexOf('class="ticket-facts"'),
        html.indexOf('class="ticket-standing"'),
      );
      expect(top, state).toBeGreaterThan(html.indexOf("<h1"));
      expect(top, state).toBeLessThan(html.indexOf('class="ticket-card"'));
    }
  });

  it("outlines Mark fixed while an assistant asks for a review", async () => {
    const states = await everyState();
    const card = states["team, the ticket an assistant worked"]!.querySelector(".ticket-card")!;
    // The assistant's card under the check is the request, so no line repeats it.
    expect(card.querySelector(".card-line")).toBeNull();
    expect(card.querySelector(".assistant-card")).not.toBeNull();
    const ask = card.querySelector(".next-action button")!;
    expect(ask.text).toBe("Mark fixed and tell the customer");
    expect(ask.classList.contains("secondary")).toBe(true);
    // With no request, the same step is the page's one filled button.
    const plain = states["team, In Progress after the customer's No"]!.querySelector(
      ".ticket-card .next-action button",
    )!;
    expect(plain.text).toBe("Mark fixed and tell the customer");
    expect(plain.classList.contains("secondary")).toBe(false);
  });

  it("says once, on the card, that the customer was asked, in place of the page's saved line", async () => {
    const { app } = buildDemo();
    const res = await asDemo(app, "demo-team")
      .post("/tickets/SUP-3/ready")
      .set(FROM_THIS_SITE)
      .type("form")
      .send({});
    const page = parse(
      (
        await visitor(app)
          .set("Cookie", [`${DEV_COOKIE}=demo-team`, ...[res.headers["set-cookie"]].flat()])
          .get("/tickets/SUP-3")
      ).text,
    );
    expect(page.querySelector(".ticket-card [role=status]")?.text).toBe(
      "Asked the customer: Did this fix it?",
    );
    expect(page.querySelector("p.saved")).toBeNull();
    // On the next visit, the card's own line takes its place.
    const later = await ticketPage(app, "demo-team", "SUP-3");
    expect(later.querySelector(".ticket-card [role=status]")).toBeNull();
    expect(later.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Waiting for the customer's answer\. Asked /,
    );
  });
});

describe("a ticket with no check", () => {
  const noCheck = { title: "Printer jams", description: "It jams on page two." };

  it("shows the card without the label and the quote, when there is a step", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(noCheck);
    const card = parse((await as(app, teamActor).get("/tickets/SUP-1")).text).querySelector(
      ".ticket-card",
    )!;
    expect(parts(card)).toEqual(["step"]);
    expect(card.text).not.toContain("What would prove it");
  });

  it("shows its filer only the quiet link to add what would prove it", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(noCheck);
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    const card = page.querySelector(".ticket-card")!;
    expect(card.querySelectorAll("a, button").map((control) => control.text)).toEqual([
      "Add what would prove it",
    ]);
    expect(card.text.trim()).toBe("Add what would prove it");
  });
});

describe("the customer's answer", () => {
  async function asked() {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const ready = await as(app, teamActor).post("/api/tickets/SUP-1/ready").send({});
    return { app, token: ready.body.ready_token as string };
  }

  it("is the question, the quote and two buttons, with No closed until it is opened", async () => {
    const { app } = await asked();
    const card = parse((await as(app, customerOne).get("/tickets/SUP-1")).text).querySelector(
      "#did-this-fix-it",
    )!;
    expect(card.querySelector("h2")?.text).toBe("Did this fix it?");
    expect(card.querySelector("blockquote")?.text).toBe("Ten pages print");
    const answer = card.querySelector(".card-answer")!;
    expect(answer.querySelector("form > button")?.text).toBe("Yes, it is fixed");
    const no = answer.querySelector("details.answer-no")!;
    expect(no.querySelector("summary")?.text).toBe("No, it is not fixed");
    expect(no.hasAttribute("open")).toBe(false);
  });

  it("opens No with its message and focus after an empty No is refused", async () => {
    const { app, token } = await asked();
    const res = await as(app, customerOne)
      .post("/tickets/SUP-1/answer")
      .type("form")
      .send({ fixed: "no", comment: "", ready_token: token });
    expect(res.status).toBe(400);
    const no = parse(res.text).querySelector("#did-this-fix-it details.answer-no")!;
    expect(no.hasAttribute("open")).toBe(true);
    const box = no.querySelector("textarea#answer-comment")!;
    expect(box.hasAttribute("autofocus")).toBe(true);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(no.querySelector("#answer-error")?.text).toBe("Say what is still wrong.");
    expect(no.querySelector("button")?.text).toBe("No, send it back");
  });
});

import { parse, type HTMLElement } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, FROM_THIS_SITE, visitor } from "./helpers.js";

// The ticket page says each fact once, and has one black button: the next step. Status and
// owner live in the side panel, the key in the line above the title, the filing time in
// History. The lines that repeated those facts, or said what a button already says, are gone.
// Each state below is a ticket of the demo's sample data, as the team or the customer sees it.

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

/** Every state the design review names for the ticket page, each as its viewer sees it. */
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
  return { app, service, pages };
}

/** The filled buttons in the page's main area: every button not drawn as outlined or a link. */
function filledButtons(page: HTMLElement): string[] {
  const quiet = ["secondary", "outline", "link", "danger"];
  return page
    .querySelectorAll("main :is(button, [role=button])")
    .filter((button) => !button.hasAttribute("disabled"))
    .filter((button) => !quiet.some((name) => button.classList.contains(name)))
    .map((button) => button.text.trim());
}

describe("the ticket page's one black button", () => {
  it("is at most one filled button in the main area, in every state", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      expect(filledButtons(page).length, state).toBeLessThanOrEqual(1);
    }
    // Where there is a next step, it is the filled one.
    const filled = Object.fromEntries(pages.map(([state, page]) => [state, filledButtons(page)]));
    expect(filled["team, New with no owner"]).toEqual(["Take ticket and start work"]);
    expect(filled["team, In Progress after the customer's No"]).toEqual([
      "Ask the customer to verify",
    ]);
    expect(filled["customer, asked Did this fix it?"]).toEqual(["Yes, resolve ticket"]);
  });

  it("draws the reply box's send button and the assistant card's accept as outlined", async () => {
    const { pages } = await everyState();
    const assistant = pages.find(([state]) => state === "team, the ticket an assistant worked")![1];
    const send = assistant.querySelector("form.reply-box button[type=submit]")!;
    expect(send.classList.contains("secondary")).toBe(true);
    const accept = assistant
      .querySelectorAll(".assistant-card button")
      .find((button) => button.text.trim() === "Accept as the way to test")!;
    expect(accept.classList.contains("secondary")).toBe(true);
  });
});

describe("each fact once", () => {
  const gone = [
    "Back to all tickets",
    "The customer will check",
    "Sends the customer",
    "Add details first (optional)",
    "Answered ",
    "It is back with",
    "See every resolved ticket",
    "The customer's Yes resolved it",
    "Reopening takes it to",
    "spec this ticket",
    "Handed to demo assistants",
    "No replies yet.",
    "Or start your answer with one of these",
    ", waiting for",
  ];

  it("leaves out every line that repeated a fact, in every state", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      const text = page.querySelector("main")!.text.replace(/\s+/g, " ");
      for (const words of gone) expect(text, `${state}: ${words}`).not.toContain(words);
    }
  });

  it("puts the way back and the key above the title, and nothing under it", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      const title = page.querySelector("main h1")!;
      const above = title.previousElementSibling!;
      expect(above.classList.contains("back"), state).toBe(true);
      const customer = state.startsWith("customer");
      expect(above.text.trim(), state).toMatch(
        customer ? /^My tickets \/ SUP-\d+$/ : /^All tickets \/ SUP-\d+$/,
      );
      expect(above.querySelector("a")?.getAttribute("href")).toBe("/tickets");
      // The title is followed by the ticket's two columns, with no line of facts between.
      expect(title.nextElementSibling?.classList.contains("ticket-layout"), state).toBe(true);
      expect(page.querySelector("hgroup"), state).toBeNull();
    }
  });

  it("keeps the browser tab's title naming the key", async () => {
    const { app } = buildDemo();
    const page = await ticketPage(app, "demo-team", "SUP-8");
    expect(page.querySelector("title")?.text).toMatch(/^SUP-8: /);
  });

  it("keeps Description and Conversation as headings for screen readers only", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      const hidden = page
        .querySelectorAll("main h2.visually-hidden")
        .map((heading) => heading.text);
      expect(hidden, state).toEqual(["Description", "Conversation"]);
    }
  });

  it("adds no note beside the next step: its label says what it does", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      expect(page.querySelector(".next-note"), state).toBeNull();
    }
  });
});

describe("the side panel", () => {
  it("holds Status, then Owner, as two rows with small labels, then Edit ticket last", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      const panel = page.querySelector("aside.ticket-panel")!;
      const labels = panel.querySelectorAll(".panel-label").map((label) => label.text);
      // The customer sees no Owner row until somebody owns the ticket.
      const owned = state !== "customer, their own New ticket";
      expect(labels, state).toEqual(owned ? ["Status", "Owner"] : ["Status"]);
      expect(panel.querySelectorAll(".panel-label, h2")[0]?.text, state).toBe("Status");
      const edit = panel.querySelector("a.edit-link");
      if (edit) expect(panel.lastElementChild?.querySelector("a.edit-link"), state).toBe(edit);
    }
  });

  it("comes first in the ticket's columns, so a phone shows it directly under the title", async () => {
    const { pages } = await everyState();
    for (const [state, page] of pages) {
      const layout = page.querySelector(".ticket-layout")!;
      // Nothing of the ticket sits between the title and the two columns.
      expect(layout.previousElementSibling?.tagName, state).toBe("H1");
    }
  });

  it("shows the status in plain words when this viewer can press none of it", async () => {
    const { pages } = await everyState();
    const resolved = pages.find(([state]) => state === "team, Resolved by the customer")![1];
    const status = resolved.querySelector("aside.ticket-panel .status-control")!;
    expect(status.querySelector(".status-row, button")).toBeNull();
    expect(status.querySelector(".badge")?.text).toBe("Resolved");
    expect(status.querySelector(".status-rule")?.text.trim()).toBe(
      "Only the customer can reopen a ticket they confirmed.",
    );
  });
});

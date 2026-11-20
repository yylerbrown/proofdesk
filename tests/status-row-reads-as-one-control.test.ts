import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { SAVED_MESSAGES } from "../src/server/pages/saved.js";
import { createTicketService } from "../src/server/tickets/service.js";

// On a ticket page the Status menu and the button at the top read as one control: both post to
// the same place, so the same message follows either press, and that message says the viewer
// owns the ticket now. Resolving starts with no reason chosen. "Edit" is a quiet link at the end
// of the line under the title, and the list's empty search names only what is set.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages",
};

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

const page = async (app: Express, who = teamActor, at = "/tickets/SUP-1") =>
  parse((await as(app, who).get(at)).text);

/** The demo, seeded, and a page of it as one of its made-up people. */
async function demoPage(person: string, at: string) {
  const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(db, config.ticketPrefix));
  return parse((await visitor(app).set("Cookie", `${DEV_COOKIE}=${person}`).get(at)).text);
}

describe("In Progress on a ticket nobody owns", () => {
  it("posts where the button at the top does, and the message after says you own it", async () => {
    const { app } = await filed();
    const html = await page(app);
    // The choice says it makes the viewer the owner, and the message after the press says it too.
    const rowButton = html
      .querySelectorAll(".status-menu form button")
      .find((button) => button.text.trim() === "In Progress (assigns it to you)")!;
    // Both post to the same place, so both end on the same message.
    const top = html
      .querySelectorAll(".next-action form")
      .find((form) => form.querySelector("button")?.text.trim() === "Take ticket and start work")!;
    expect(rowButton.closest("form")?.getAttribute("action")).toBe(top.getAttribute("action"));
    expect(top.getAttribute("action")).toBe("/tickets/SUP-1/take-and-start");
    const pressed = await as(app, teamActor).post("/tickets/SUP-1/take-and-start");
    expect(pressed.status).toBe(303);
    expect(String(pressed.headers["set-cookie"])).toContain("saved=started");
    expect(SAVED_MESSAGES.started).toBe("You own this ticket, and it is in progress.");
  });
});

describe("the resolve form's first choice", () => {
  it("is none, so a hurried press can never claim a fix", async () => {
    const { app } = await filed();
    const form = (await page(app, teamActor, "/tickets/SUP-1?step=resolve")).querySelector(
      "form.resolve",
    )!;
    const radios = form.querySelectorAll('input[type=radio][name="reason"]');
    expect(radios.every((radio) => radio.hasAttribute("required"))).toBe(true);
    expect(radios.filter((radio) => radio.hasAttribute("checked"))).toHaveLength(0);
    expect(form.querySelector("select")).toBeNull();
    expect(form.text).not.toContain("Choose a reason");
    // "Fixed." is still offered, one choice away.
    expect(form.querySelector('input[value="fixed_no_reply"]')).not.toBeNull();
  });

  it("keeps what was picked when a try is refused", async () => {
    const { app } = await filed();
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "" });
    expect(refused.status).toBe(400);
    const form = parse(refused.text).querySelector("form.resolve")!;
    const chosen = form
      .querySelectorAll("input[name=reason]")
      .filter((o) => o.hasAttribute("checked"));
    expect(chosen.map((o) => o.getAttribute("value"))).toEqual(["other"]);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("new");
  });
});

describe("Edit", () => {
  it("sits on the line under the title, and More options goes when nothing is left in it", async () => {
    // SUP-5 is the demo customer's confirmed ticket; they may edit it and little else.
    const html = await demoPage("demo-customer", "/tickets/SUP-5");
    const edit = html.querySelector(".ticket-standing a.ticket-line-link")!;
    expect(edit.getAttribute("href")).toBe("/tickets/SUP-5/edit");
    expect(edit.text.trim()).toBe("Edit");
    expect(html.querySelectorAll("a[href$='/edit']")).toHaveLength(1);
    expect(html.querySelector("details.more-options")).toBeNull();
  });

  it("puts the filer's Archive beside it, so their More options goes", async () => {
    const { app } = await filed();
    const html = await page(app, customerOne);
    const line = html.querySelector(".ticket-standing")!;
    expect(line.querySelectorAll("a").map((el) => el.text.trim())).toEqual(["Edit", "Archive"]);
    expect(html.querySelector("details.more-options")).toBeNull();
  });
});

describe("the list's empty search", () => {
  const sentence = async (app: Express, query: string) =>
    (await page(app, teamActor, `/tickets?${query}`)).querySelector("p.empty")!.text.trim();

  it("names only what is set", async () => {
    const { app } = await filed();
    expect(await sentence(app, "q=zzz")).toBe('No tickets match "zzz". Clear the search.');
    expect(await sentence(app, "owner=me")).toBe(
      "No tickets that you own. Clear the owner filter.",
    );
    expect(await sentence(app, "owner=me&q=zzz")).toBe(
      'No tickets that you own and match "zzz". Clear the owner filter and the search.',
    );
  });
});

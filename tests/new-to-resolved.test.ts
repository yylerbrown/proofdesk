import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  refusedBackToTicket,
  teamActor,
  visitor,
} from "./helpers.js";

// The minimum features, as a first-time visitor meets them: a ticket starts New, one action owns
// it and starts work, and Resolved is never a dead end. The status is a small menu of the three
// statuses, and when this viewer cannot choose one, its title says who can.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
  where_url: "https://example.com/print",
};

const page = async (app: Express, who: typeof teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text);
const rule = (html: ReturnType<typeof parse>) =>
  html.querySelector(".ticket-facts [title]")?.getAttribute("title");
const resolveLink = (html: ReturnType<typeof parse>) =>
  html.querySelector(".status-menu a[href$='?step=resolve#resolve-form']");

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

describe("a new ticket", () => {
  it("is New once filed, without the form announcing it", async () => {
    const { app } = buildTestApp();
    const form = parse((await as(app, customerOne).get("/tickets/new").redirects(1)).text);
    // A default is not announced on the form.
    expect(form.text).not.toContain("Initial status");
    const res = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "It jams on page two.", fix_check: "" });
    expect(res.status).toBe(303);
    expect(
      (await page(app, customerOne)).querySelector(".ticket-standing .standing-rest")?.text,
    ).toBe(", not yet taken by the team");
    // Editing an existing ticket says nothing about how it starts.
    const edit = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(edit.querySelector(".initial-status")).toBeNull();
  });

  it("is owned and in progress after one action from the team", async () => {
    const { app } = await filed();
    const html = await page(app, teamActor);
    const take = html.querySelector(".next-action form[action$='/take-and-start'] button");
    expect(take?.text).toBe("Take ticket and start work");
    expect((await as(app, teamActor).post("/tickets/SUP-1/take-and-start")).status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Team Member" });
  });
});

describe("where Resolved comes from", () => {
  it("is offered to the team at every step, with the customer's Yes as the next action", async () => {
    const { app } = await filed();
    const fresh = await page(app, teamActor);
    expect(fresh.querySelector(".next-action button")?.text).toBe("Take ticket and start work");
    expect(resolveLink(fresh)?.text).toBe("Resolved");
    // Nothing is greyed, so the row needs no line under it. The success message says that
    // In Progress also made you the owner.
    expect(rule(fresh)).toBeUndefined();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");

    // In progress: the next action marks it fixed and tells the customer in one press. Asking
    // first is behind a closed disclosure of its own, and never a greyed button.
    const owner = await page(app, teamActor);
    expect(owner.querySelector(".next-action button")?.text).toBe(
      "Mark fixed and tell the customer",
    );
    const details = owner.querySelector("details#ask")!;
    expect(details.hasAttribute("open")).toBe(false);
    expect(details.querySelector("summary")?.text).toBe("Ask before resolving");
    expect(details.querySelector("button[type=submit]")?.hasAttribute("disabled")).toBe(false);
    expect(owner.querySelector("#ask-blocked-why")).toBeNull();
    expect(resolveLink(owner)?.text).toBe("Resolved");

    // An admin may resolve it with a reason too, but only its owner has the next step, so the
    // admin is shown no step at all rather than a greyed one.
    const byAdmin = await page(app, adminActor);
    expect(resolveLink(byAdmin)).not.toBeNull();
    expect(byAdmin.querySelector("#ask-blocked-why")).toBeNull();
    expect(byAdmin.querySelector("main")!.text).not.toContain("Mark fixed and tell the customer");
    // The customer reads the status, with no control to change it.
    expect((await page(app, customerOne)).querySelector(".status-menu")).toBeNull();
  });

  it("does not tell the read-only admin preview to take a ticket it cannot take", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const preview = visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-admin`);
    const tickets = (await preview.get("/api/tickets")).body as {
      key: string;
      status: string;
      owner_name: string | null;
    }[];
    const unowned = tickets.find((t) => t.status === "new" && t.owner_name === null)!;
    const html = parse((await preview.get(`/tickets/${unowned.key}`)).text);
    expect(rule(html)).toBe("The preview is read-only.");
    expect(html.querySelector("main")!.text).not.toMatch(/Take the ticket|Start work/);
  });

  it("answers a try to set Resolved on the ticket itself, naming the way to get there", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const reason = await refusedBackToTicket(as(app, teamActor), "/tickets/SUP-1/status", {
      status: "resolved",
    });
    expect(reason).toMatch(/^A status change does not resolve ticket SUP-1\./);
    // It names the buttons the team has, and each one is on the ticket's page.
    const main = (await page(app, teamActor)).querySelector("main")!.text;
    const api = await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "resolved" });
    for (const button of ["Mark fixed and tell the customer", "Ask before resolving"]) {
      expect(reason).toContain(button);
      expect(api.body.error.hint).toContain(button);
      expect(main).toContain(button);
    }
    expect(reason).toMatch(/resolves it as fixed at once/);
    expect(api.body.error.hint).toMatch(/resolves it as fixed at once/);
    for (const said of [reason, api.body.error.hint]) {
      expect(said).not.toContain("Ask the customer to verify");
    }
  });

  it("says who it waits for once asked, and that their Yes moves it to Resolved", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const before = await page(app, teamActor);
    // The details are one optional message; the API takes the page to try and the rest.
    const message = before.querySelector("#ask textarea[name=response]")!;
    expect(message.parentNode!.text).toContain("Message to the customer (optional)");
    expect(message.hasAttribute("required")).toBe(false);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/print", tried: "Printed.", result: "No jam." });

    const team = await page(app, teamActor);
    expect(team.querySelector(".ticket-facts .badge")?.text).toBe("In Progress");
    expect(team.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Waiting for the customer's answer\. Asked /,
    );
    // Said once, on the card, and not again with the status.
    expect(rule(team)).toBeUndefined();

    const customer = await page(app, customerOne);
    expect(customer.querySelector(".ticket-standing .standing-rest")?.text).toBe(
      ", with Team Member",
    );
    // The question itself is on the page, in place of a line saying it is waiting.
    expect(customer.querySelector("#did-this-fix-it")).not.toBeNull();
    expect(customer.querySelector("main")!.text).not.toContain("Waiting for the customer");
  });

  it("does not hold the ask back when the customer gave no check", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams on page two." });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const html = await page(app, teamActor);
    expect(html.querySelector("button[disabled]")).toBeNull();
    expect(html.querySelector("#ask-blocked-why")).toBeNull();
  });
});

describe("the customer's answer", () => {
  it("offers Yes as the one filled button, and No as a quiet fold-open with its own box", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/print", tried: "Printed.", result: "No jam." });
    const box = (await page(app, customerOne)).querySelector("#did-this-fix-it")!;
    // The two answers, and nothing else to press.
    const buttons = box.querySelectorAll("button");
    expect(buttons.map((b) => b.text)).toEqual(["Yes, it is fixed", "No, send it back"]);
    expect(buttons[0]!.classList.contains("secondary")).toBe(false);
    // No opens with a native fold-open, so it works with scripts off, closed at first.
    const no = box.querySelector("details.answer-no")!;
    expect(no.hasAttribute("open")).toBe(false);
    expect(no.querySelector("summary")?.text).toBe("No, it is not fixed");
    expect(no.querySelector("label[for=answer-comment]")?.text).toBe("What is still wrong?");
    expect(no.querySelector("button")?.classList.contains("secondary")).toBe(true);
    expect(box.querySelector("button.danger")).toBeNull();
  });
});

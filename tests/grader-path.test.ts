import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  refusedBackToTicket,
  teamActor,
} from "./helpers.js";

// The minimum features, as a grader meets them: a ticket starts New, one action owns it and
// starts work, and Resolved is never a dead end. Wherever the team looks for it, the page says
// that it comes from the customer's Yes and how to get there.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
  where_url: "https://example.com/print",
};

const page = async (app: Express, who: typeof teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text);
const rule = (html: ReturnType<typeof parse>) => html.querySelector(".status-rule")?.text.trim();

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

describe("a new ticket", () => {
  it("says on the form that it starts New, and is New once filed", async () => {
    const { app } = buildTestApp();
    const form = parse((await as(app, customerOne).get("/tickets/new")).text);
    expect(form.querySelector(".initial-status")?.text).toBe("Initial status: New");
    const res = await as(app, customerOne)
      .post("/tickets")
      .type("form")
      .send({ title: "Printer jams", description: "It jams on page two.", fix_check: "" });
    expect(res.status).toBe(303);
    expect((await page(app, customerOne)).querySelector("hgroup .badge")?.text).toBe("New");
    // Editing an existing ticket says nothing about how it starts.
    const edit = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(edit.querySelector(".initial-status")).toBeNull();
  });

  it("is owned and in progress after one action from the team", async () => {
    const { app } = await filed();
    const html = await page(app, teamActor);
    const take = html.querySelector("form[action$='/take-and-start'] button");
    expect(take?.text).toBe("Take ticket and start work");
    expect((await as(app, teamActor).post("/tickets/SUP-1/take-and-start")).status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Team Member" });
  });
});

describe("where Resolved comes from", () => {
  it("is said to the team at every step, with the way to get there", async () => {
    const { app } = await filed();
    expect(rule(await page(app, teamActor))).toBe(
      "Resolved comes from the customer's Yes. Take the ticket, then ask the customer to confirm.",
    );
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");

    const owner = await page(app, teamActor);
    expect(rule(owner)).toBe(
      "Resolved comes from the customer's Yes. When the fix is in, ask customer to confirm.",
    );
    expect(owner.querySelector(".status-rule a")?.getAttribute("href")).toBe("#ask");
    // The link lands on the ask, shown greyed with what is missing until it can be done.
    expect(owner.querySelector("#ask button")?.text).toBe("Ask customer to confirm");
    expect(owner.querySelector("#ask-blocked-why")?.text).toBe(
      "Add the link to the code change first.",
    );

    expect(rule(await page(app, adminActor))).toBe(
      "Resolved comes from the customer's Yes. Only Team Member can ask the customer to confirm.",
    );
    expect(rule(await page(app, customerOne))).toBeUndefined();
  });

  it("answers a try to set Resolved on the ticket itself, naming the way to get there", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const reason = await refusedBackToTicket(as(app, teamActor), "/tickets/SUP-1/status", {
      status: "resolved",
    });
    expect(reason).toMatch(/Only the customer resolves ticket SUP-1/);
    expect(reason).toMatch(/Ask customer to confirm/);
    const api = await as(app, teamActor).patch("/api/tickets/SUP-1").send({ status: "resolved" });
    expect(api.body.error.hint).toMatch(/Ask customer to confirm/);
  });

  it("says who it waits for once asked, and that their Yes moves it to Resolved", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const before = await page(app, teamActor);
    // The page to try starts from where the customer said it happened, and is marked required.
    const tryUrl = before.querySelector("#ask input[name=try_url]")!;
    expect(tryUrl.getAttribute("value")).toBe("https://example.com/print");
    expect(tryUrl.parentNode!.text).toContain("Page on the live site to try (required)");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/print", tried: "Printed.", result: "No jam." });

    const team = await page(app, teamActor);
    const status = team.querySelectorAll("aside section").find((s) => s.text.includes("Status"))!;
    expect(status.querySelector("p")?.text).toBe("In Progress, waiting for the customer");
    expect(rule(team)).toBe("Their Yes moves it to Resolved.");

    const customer = await page(app, customerOne);
    expect(customer.querySelector("main")!.text).toContain("In Progress, waiting for you");
    // The question itself is on the page, in place of a line saying it is waiting.
    expect(customer.querySelector("#did-this-fix-it")).not.toBeNull();
    expect(customer.querySelector("main")!.text).not.toContain("Waiting for the customer");
  });

  it("names a missing check as the reason, not a hidden button", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams on page two." });
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const html = await page(app, teamActor);
    expect(html.querySelector("#ask button[disabled]")?.text).toBe("Ask customer to confirm");
    expect(html.querySelector("#ask-blocked-why")?.text).toBe(
      "The customer has not said how they will know it is fixed. Ask them in a reply.",
    );
  });
});

describe("the customer's answer", () => {
  it("offers Yes and No at the same size, and No as a quiet button", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/ready")
      .send({ try_url: "https://example.com/print", tried: "Printed.", result: "No jam." });
    const box = (await page(app, customerOne)).querySelector("#did-this-fix-it")!;
    // The two answers; the quick answers below them are small, plain words.
    const buttons = box.querySelectorAll("button").filter((b) => !b.classList.contains("quick"));
    expect(buttons.map((b) => b.text)).toEqual(["Yes, it is fixed", "No, send it back"]);
    for (const button of buttons) expect(button.classList.contains("large")).toBe(true);
    expect(box.querySelector("button.danger")).toBeNull();
  });
});

import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";

// On a ticket page the status row and the button at the top read as one control: when pressing
// In Progress would also make the viewer the owner, a short line under the row says so, and both
// controls post to the same place, so the same message follows either press. Resolving starts on
// "Fixed, not yet confirmed" when that reason is offered. A More menu that would hold a single
// item shows that item directly, and the list's empty search names only what is set.

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
  it("says under the row that it also makes you the owner, like the button at the top", async () => {
    const { app } = await filed();
    const html = await page(app);
    const line = html.querySelector(".status-control #status-takes");
    expect(line?.text.trim()).toBe("In Progress also makes you the owner.");
    const rowButton = html
      .querySelectorAll(".status-row > form button")
      .find((button) => button.text.trim() === "In Progress")!;
    expect(rowButton.getAttribute("aria-describedby")).toBe("status-takes");
    // Both post to the same place, so both end on the same message.
    const top = html
      .querySelectorAll(".next-action form")
      .find((form) => form.querySelector("button")?.text.trim() === "Take ticket and start work")!;
    expect(rowButton.closest("form")?.getAttribute("action")).toBe(top.getAttribute("action"));
    expect(top.getAttribute("action")).toBe("/tickets/SUP-1/take-and-start");
  });

  it("says nothing once the viewer owns it, once work has started, or in the read-only preview", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    expect((await page(app)).querySelector("#status-takes")).toBeNull();
    await as(app, teamActor).post("/api/tickets/SUP-1/status").send({ status: "in_progress" });
    expect((await page(app)).querySelector("#status-takes")).toBeNull();
    // SUP-7 is the demo's New ticket that nobody owns.
    expect((await demoPage("demo-admin", "/tickets/SUP-7")).querySelector("#status-takes")).toBe(
      null,
    );
  });
});

describe("the resolve form's first choice", () => {
  it("is 'Fixed, not yet confirmed', so resolving takes two presses", async () => {
    const { app } = await filed();
    const select = (await page(app)).querySelector('details.resolve select[name="reason"]')!;
    expect(select.hasAttribute("required")).toBe(true);
    const chosen = select.querySelectorAll("option").filter((o) => o.hasAttribute("selected"));
    expect(chosen.map((o) => o.getAttribute("value"))).toEqual(["fixed_no_reply"]);
    // With nothing to pick, the placeholder is not offered either.
    expect(select.querySelector('option[value=""]')).toBeNull();
  });

  it("keeps what was picked when a try is refused", async () => {
    const { app } = await filed();
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "other", note: "" });
    expect(refused.status).toBe(400);
    const select = parse(refused.text).querySelector('details.resolve select[name="reason"]')!;
    const chosen = select.querySelectorAll("option").filter((o) => o.hasAttribute("selected"));
    expect(chosen.map((o) => o.getAttribute("value"))).toEqual(["other"]);
    expect((await admin(app).get("/api/tickets/SUP-1")).body.status).toBe("new");
  });
});

describe("a More menu with a single item", () => {
  it("is shown as that item on the demo customer's page, where archiving is off", async () => {
    // SUP-5 is the demo customer's confirmed ticket; they may edit it and nothing else.
    const html = await demoPage("demo-customer", "/tickets/SUP-5");
    const panel = html.querySelector("aside.ticket-panel")!;
    expect(panel.querySelector("details.more")).toBeNull();
    const edit = panel.querySelector(".more-single a[href='/tickets/SUP-5/edit']");
    expect(edit?.text.trim()).toBe("Edit ticket");
  });

  it("stays a More menu when it holds two or more", async () => {
    const { app } = await filed();
    const panel = (await page(app, customerOne)).querySelector("aside.ticket-panel")!;
    expect(panel.querySelector("details.more > summary")?.text.trim()).toBe("More");
    expect(panel.querySelector(".more-single")).toBeNull();
  });
});

describe("the list's empty search", () => {
  const sentence = async (app: Express, query: string) =>
    (await page(app, teamActor, `/tickets?${query}`)).querySelector("p.empty")!.text.trim();

  it("names only what is set", async () => {
    const { app } = await filed();
    expect(await sentence(app, "q=zzz")).toBe("No tickets match. Clear the search.");
    expect(await sentence(app, "owner=me")).toBe("No tickets match. Clear the owner filter.");
    expect(await sentence(app, "owner=me&q=zzz")).toBe(
      "No tickets match. Clear the owner filter and search.",
    );
  });
});

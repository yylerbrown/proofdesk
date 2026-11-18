import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  resolveTicket,
  teamActor,
  visitor,
} from "./helpers.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";

// Changing a ticket's status, as a team member finds it: in the side panel, one row of the
// three statuses, New, In Progress and Resolved. The current one is marked and is not a
// button. Each other one is a single press when this viewer may make that move, or a disabled
// button with one short line beside the row saying why, so all three always show. The
// customer's page gains nothing from this.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

type Who = typeof teamActor;

/** The side panel's Status section, as this person sees it. */
async function statusSection(app: Express, who: Who) {
  const html = parse((await as(app, who).get("/tickets/SUP-1")).text);
  const sections = html.querySelectorAll("aside.ticket-panel section");
  return sections.find((s) => s.querySelector("h2")?.text === "Status") ?? null;
}

type Section = NonNullable<Awaited<ReturnType<typeof statusSection>>>;

/**
 * The status row, left to right, as "Label: how", where how is current (marked, not a
 * button), press (a form with one button), opens (a disclosure that asks for a reason first)
 * or disabled.
 */
function row(section: Section): string[] {
  const group = section.querySelector(".status-row")!;
  return group.childNodes
    .filter((node) => node.nodeType === 1)
    .map((node) => {
      const item = node as unknown as Section;
      if (item.getAttribute("aria-current") === "true") return `${item.text.trim()}: current`;
      const summary = item.querySelector("summary");
      if (summary) return `${summary.text.trim()}: opens`;
      const button = item.querySelector("button")!;
      if (button.hasAttribute("disabled")) return `${button.text.trim()}: disabled`;
      return `${button.text.trim()}: press`;
    });
}

/** The one line beside the row saying why a status cannot be pressed, or null. */
function why(section: Section): string | null {
  return section.querySelector("#status-why")?.text.trim() ?? null;
}

/** The form behind one status's button. */
function formFor(section: Section, label: string) {
  return section
    .querySelectorAll(".status-row > form")
    .find((form) => form.querySelector("button")?.text.trim() === label)!;
}

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

describe("the status control", () => {
  it("on a New ticket marks New, takes and starts with In Progress, and opens the reason for Resolved", async () => {
    const { app } = await filed();
    const section = (await statusSection(app, teamActor))!;
    expect(row(section)).toEqual(["New: current", "In Progress: press", "Resolved: opens"]);
    expect(why(section)).toBeNull();
    expect(formFor(section, "In Progress").getAttribute("action")).toBe(
      "/tickets/SUP-1/take-and-start",
    );
    // A details element, so it opens without scripts, holding the existing reason chooser.
    const resolve = section.querySelector(".status-row details.resolve")!;
    expect(resolve.querySelector("summary")?.getAttribute("role")).toBe("button");
    expect(resolve.querySelector("form")?.getAttribute("action")).toBe("/tickets/SUP-1/resolve");
    expect(resolve.querySelector("select[name=reason]")).not.toBeNull();
    expect((await as(app, teamActor).post("/tickets/SUP-1/take-and-start")).status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Team Member" });
  });

  it("starts work on a New ticket its owner holds through the status form", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const section = (await statusSection(app, teamActor))!;
    const form = formFor(section, "In Progress");
    expect(form.getAttribute("action")).toBe("/tickets/SUP-1/status");
    expect(form.querySelector("input[name=status]")?.getAttribute("value")).toBe("in_progress");
  });

  it("on an In Progress ticket gives its owner and admins New and Resolved, one press each", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    for (const who of [teamActor, adminActor]) {
      const section = (await statusSection(app, who))!;
      expect(row(section)).toEqual(["New: press", "In Progress: current", "Resolved: opens"]);
      const back = formFor(section, "New");
      expect(back.getAttribute("action")).toBe("/tickets/SUP-1/status");
      expect(back.querySelector("input[name=status]")?.getAttribute("value")).toBe("new");
    }
  });

  it("shows another team member every status, greyed, with one line saying who can", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    const section = (await statusSection(app, teamActor))!;
    expect(row(section)).toEqual(["New: disabled", "In Progress: current", "Resolved: disabled"]);
    expect(why(section)).toBe("Only Admin, who owns it, or an admin can change its status.");
    const greyed = section.querySelectorAll(".status-row button[disabled]");
    expect(greyed).toHaveLength(2);
    for (const button of greyed) expect(button.getAttribute("aria-describedby")).toBe("status-why");
  });

  it("on a ticket the customer confirmed says only they can reopen it", async () => {
    const { app } = await filed();
    await resolveTicket(app, "SUP-1", customerOne);
    for (const who of [teamActor, adminActor]) {
      const section = (await statusSection(app, who))!;
      expect(row(section)).toEqual(["New: disabled", "In Progress: disabled", "Resolved: current"]);
      expect(why(section)).toBe("Only the customer can reopen a ticket they confirmed.");
    }
  });

  it("on a team-resolved ticket tells another team member who can reopen it, the customer too", async () => {
    const { app } = await filed();
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    await admin(app).post("/api/tickets/SUP-1/resolve").send({ reason: "wont_fix" }).expect(200);
    const section = (await statusSection(app, teamActor))!;
    expect(row(section)).toEqual(["New: disabled", "In Progress: disabled", "Resolved: current"]);
    expect(why(section)).toBe("Only Admin, who owns it, an admin or the customer can reopen it.");
  });

  it("on a team-resolved ticket opens the owner's reopen from In Progress, and the server accepts it", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "wont_fix" })
      .expect(200);
    const section = (await statusSection(app, teamActor))!;
    expect(row(section)).toEqual(["New: disabled", "In Progress: opens", "Resolved: current"]);
    expect(why(section)).toBe("Reopening takes it to In Progress.");
    const reopen = section.querySelector(".status-row details.reopen form")!;
    expect(reopen.getAttribute("action")).toBe("/tickets/SUP-1/reopen");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Resolved by mistake." })
      .expect(200);
    expect(row((await statusSection(app, teamActor))!)).toEqual([
      "New: press",
      "In Progress: current",
      "Resolved: opens",
    ]);
  });

  it("is greyed for the demo's read-only admin preview, with the reason", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const page = await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-admin`).get("/tickets/SUP-1");
    const sections = parse(page.text).querySelectorAll("aside.ticket-panel section");
    const section = sections.find((s) => s.querySelector("h2")?.text === "Status")!;
    expect(row(section)).toEqual(["New: disabled", "In Progress: current", "Resolved: disabled"]);
    expect(why(section)).toBe("The preview is read-only.");
  });

  it("is the only status control: no Start work, no second Ask, no Take under More", async () => {
    const { app } = await filed();
    const fresh = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(fresh.querySelector("aside.ticket-panel")!.text).not.toMatch(/Start work|Take this/);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const asks = page
      .querySelectorAll("button, summary")
      .filter((control) => control.text.trim() === "Ask the customer to verify");
    // The one at the top of the page, the product's recommended next step.
    expect(asks).toHaveLength(1);
    expect(asks[0]!.closest(".next-action")).not.toBeNull();
  });
});

describe("the customer's page", () => {
  it("gains no status section and keeps its own way to reopen", async () => {
    const { app } = await filed();
    expect(await statusSection(app, customerOne)).toBeNull();
    await resolveTicket(app, "SUP-1", customerOne);
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(html.querySelector("aside.ticket-panel")!.text).not.toMatch(/Start work|Resolve|Reopen/);
    expect(html.querySelector("#reopen summary")?.text).toBe("Still happening?");
    expect(html.querySelector("summary[role=button]")).toBeNull();
  });
});

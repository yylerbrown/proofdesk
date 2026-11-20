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

// Changing a ticket's status, as a team member finds it: under the title, a small Status menu of
// the three statuses, New, In Progress and Resolved. The current one is marked and is not a
// button. Each other one is a single press when this viewer may make that move, or greyed with
// its reason as a title and as hidden words. When this viewer can press none of them, the
// status is plain words with that reason as its title, not a menu of greyed choices. The
// customer's page gains nothing from this.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

type Who = typeof teamActor;
type Html = ReturnType<typeof parse>;

/** The Status part of the line under the title, as this person sees it: a menu or plain words. */
async function statusSection(app: Express, who: Who) {
  const html = parse((await as(app, who).get("/tickets/SUP-1")).text);
  return statusIn(html);
}

function statusIn(html: Html): Html | null {
  const parts = html.querySelectorAll(".ticket-facts > details, .ticket-facts > .fact");
  return parts.find((part) => part.querySelector(".fact-label")?.text === "Status") ?? null;
}

type Section = NonNullable<Awaited<ReturnType<typeof statusSection>>>;

/** What a choice shows on screen, without the words only a screen reader hears. */
function shown(item: Section): string {
  const copy = parse(item.toString());
  for (const hidden of copy.querySelectorAll(".visually-hidden")) hidden.remove();
  return copy.text.trim();
}

/**
 * The Status menu, top to bottom, as "Label: how", where how is current (marked, not a
 * button), press (a form with one button), opens (a link to the form that asks for a reason
 * first) or disabled.
 */
function row(section: Section): string[] {
  return section.querySelectorAll("ul > li").map((item) => {
    const current = item.querySelector('[aria-current="true"]');
    if (current) return `${current.text.trim()}: current`;
    const link = item.querySelector("a");
    if (link) return `${link.text.trim()}: opens`;
    const button = item.querySelector("button")!;
    if (button.hasAttribute("disabled")) return `${shown(button)}: disabled`;
    return `${shown(button)}: press`;
  });
}

/** The status in plain words, when this viewer can press none of the menu. */
function plain(section: Section): string | null {
  if (section.tagName === "DETAILS" || section.querySelector("button") !== null) return null;
  return section.querySelector(".badge")?.text.trim() ?? null;
}

/** Why a status cannot be chosen, as the title on it, or null. */
function why(section: Section): string | null {
  const titled = section.getAttribute("title") ? section : section.querySelector("[title]");
  return titled?.getAttribute("title") ?? null;
}

/** The form behind one status's button. */
function formFor(section: Section, label: string) {
  return section
    .querySelectorAll("ul > li > form")
    .find((form) => shown(form.querySelector("button")!).startsWith(label))!;
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
    // Nobody owns it, so In Progress says it makes the viewer the owner too.
    expect(row(section)).toEqual([
      "New: current",
      "In Progress (assigns it to you): press",
      "Resolved: opens",
    ]);
    expect(why(section)).toBeNull();
    expect(formFor(section, "In Progress").getAttribute("action")).toBe(
      "/tickets/SUP-1/take-and-start",
    );
    // A details element, so it opens without scripts. Resolved links to the same page with the
    // reason form shown in the next step's place.
    expect(section.tagName).toBe("DETAILS");
    const resolve = section.querySelector("a")!;
    expect(resolve.getAttribute("href")).toBe("/tickets/SUP-1?step=resolve#resolve-form");
    const shownForm = parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text);
    const form = shownForm.querySelector(".ticket-card form#resolve-form")!;
    expect(form.getAttribute("action")).toBe("/tickets/SUP-1/resolve");
    expect(form.querySelectorAll("input[type=radio][name=reason]")).toHaveLength(5);
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
      expect(row(section)).toEqual([
        "New (unassigns it): press",
        "In Progress: current",
        "Resolved: opens",
      ]);
      const back = formFor(section, "New");
      expect(back.getAttribute("action")).toBe("/tickets/SUP-1/status");
      expect(back.querySelector("input[name=status]")?.getAttribute("value")).toBe("new");
    }
  });

  it("shows another team member the status in plain words, with one line saying who can", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    const section = (await statusSection(app, teamActor))!;
    expect(plain(section)).toBe("In Progress");
    expect(why(section)).toBe("Only Admin, who owns it, or an admin can change its status.");
  });

  it("gives a greyed status the line that says why, when another one can be pressed", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const section = (await statusSection(app, adminActor))!;
    // An admin may resolve a New ticket another person owns, but only its owner starts work.
    expect(row(section)).toEqual(["New: current", "In Progress: disabled", "Resolved: opens"]);
    const greyed = section.querySelectorAll("button[disabled]");
    expect(greyed).toHaveLength(1);
    // The reason is its title, and words a screen reader hears, never a paragraph.
    expect(why(section)).toBe("Only Team Member, who owns it, can start work.");
    expect(greyed[0]!.querySelector(".visually-hidden")?.text).toBe(
      ". Only Team Member, who owns it, can start work.",
    );
    expect(section.querySelector("p")).toBeNull();
  });

  it("on a ticket the customer confirmed says only they can reopen it", async () => {
    const { app } = await filed();
    await resolveTicket(app, "SUP-1", customerOne);
    for (const who of [teamActor, adminActor]) {
      const section = (await statusSection(app, who))!;
      expect(plain(section)).toBe("Resolved");
      expect(why(section)).toBe("Only the customer can reopen a ticket they confirmed.");
    }
  });

  it("on a team-resolved ticket tells another team member who can reopen it, the customer too", async () => {
    const { app } = await filed();
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    await admin(app).post("/api/tickets/SUP-1/resolve").send({ reason: "wont_fix" }).expect(200);
    const section = (await statusSection(app, teamActor))!;
    expect(plain(section)).toBe("Resolved");
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
    // The button already says where reopening takes it, so no line repeats it.
    expect(why(section)).toBeNull();
    expect(section.text).not.toContain("Reopening takes it");
    expect(section.querySelector("a")?.getAttribute("href")).toBe(
      "/tickets/SUP-1?step=reopen#reopen-form",
    );
    const reopenPage = parse((await as(app, teamActor).get("/tickets/SUP-1?step=reopen")).text);
    const reopen = reopenPage.querySelector("form#reopen-form")!;
    expect(reopen.getAttribute("action")).toBe("/tickets/SUP-1/reopen");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Resolved by mistake." })
      .expect(200);
    expect(row((await statusSection(app, teamActor))!)).toEqual([
      "New (unassigns it): press",
      "In Progress: current",
      "Resolved: opens",
    ]);
  });

  it("is the status in plain words for the demo's read-only admin preview, with the reason", async () => {
    const { app, db, config } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(db, config.ticketPrefix));
    const page = await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-admin`).get("/tickets/SUP-1");
    const section = statusIn(parse(page.text))!;
    expect(plain(section)).toBe("In Progress");
    expect(why(section)).toBe("The preview is read-only.");
  });

  it("is the only status control: no Start work, no second Ask, no Take under More", async () => {
    const { app } = await filed();
    const fresh = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(fresh.querySelector(".ticket-facts")!.text).not.toMatch(/Start work|Take this/);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const asks = page
      .querySelectorAll("button, summary")
      .filter((control) => control.text.trim() === "Mark fixed and tell the customer");
    // The one at the top of the page, the product's recommended next step.
    expect(asks).toHaveLength(1);
    expect(asks[0]!.closest(".next-action")).not.toBeNull();
  });
});

describe("the customer's page", () => {
  it("shows the status as a word with no control, and keeps its own way to reopen", async () => {
    const { app } = await filed();
    const before = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(before.querySelector(".ticket-facts")).toBeNull();
    const standing = before.querySelector(".ticket-standing")!;
    expect(standing.text).toBe("New, not yet taken by the team");
    expect(standing.querySelector("form, button, details, a")).toBeNull();
    await resolveTicket(app, "SUP-1", customerOne);
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    expect(html.querySelector(".ticket-standing")!.text).not.toMatch(/Start work|Reopen/);
    expect(html.querySelector("#reopen summary")?.text).toBe("Still happening?");
    expect(html.querySelector("summary[role=button]")).toBeNull();
  });
});

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
} from "./helpers.js";

// Changing a ticket's status, as a team member finds it: in the side panel, the status and,
// directly under it, the changes this viewer can make now, each a plain button named for where
// it leads. The customer's page gains nothing from this.

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

/** The names of the status buttons in a Status section, in page order. */
function actions(section: NonNullable<Awaited<ReturnType<typeof statusSection>>>) {
  return section
    .querySelectorAll(":scope > form > button, :scope > details > summary[role=button]")
    .map((control) => control.text.trim());
}

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

describe("the Status section", () => {
  it("offers Start work and Resolve on a New ticket the viewer can take, and Start work takes and starts", async () => {
    const { app } = await filed();
    const section = (await statusSection(app, teamActor))!;
    expect(actions(section)).toEqual(["Start work", "Resolve"]);
    const form = section.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/tickets/SUP-1/take-and-start");
    expect((await as(app, teamActor).post("/tickets/SUP-1/take-and-start")).status).toBe(303);
    const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
    expect(ticket).toMatchObject({ status: "in_progress", owner_name: "Team Member" });
  });

  it("offers the owner of a New ticket Start work through the status form", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const section = (await statusSection(app, teamActor))!;
    const form = section.querySelector("form")!;
    expect(form.getAttribute("action")).toBe("/tickets/SUP-1/status");
    expect(form.querySelector("input[name=status]")?.getAttribute("value")).toBe("in_progress");
    expect(actions(section)[0]).toBe("Start work");
  });

  it("offers its owner Ask the customer to verify and Resolve on an In Progress ticket, and admins Resolve", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const owner = (await statusSection(app, teamActor))!;
    expect(actions(owner)).toEqual(["Ask the customer to verify", "Resolve"]);
    // One press asks: the form sends nothing but the ticket's address.
    const ask = owner.querySelector("form[action='/tickets/SUP-1/ready']")!;
    expect(ask.querySelectorAll("input, textarea")).toHaveLength(0);
    // A details element, so it opens without scripts; its summary reads as a button.
    const resolve = owner.querySelector("details.resolve")!;
    expect(resolve.querySelector("summary")?.getAttribute("role")).toBe("button");
    expect(resolve.querySelector("form")?.getAttribute("action")).toBe("/tickets/SUP-1/resolve");
    expect(actions((await statusSection(app, adminActor))!)).toEqual(["Resolve"]);
  });

  it("gives a team member who cannot change the status one line saying who can", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    const section = (await statusSection(app, teamActor))!;
    expect(actions(section)).toEqual([]);
    expect(section.querySelectorAll(".status-rule").map((p) => p.text.trim())).toEqual([
      "Only Admin can ask the customer to verify.",
    ]);
  });

  it("on a resolved ticket says who can reopen it when this viewer cannot", async () => {
    const { app } = await filed();
    await resolveTicket(app, "SUP-1", customerOne);
    for (const who of [teamActor, adminActor]) {
      const section = (await statusSection(app, who))!;
      expect(actions(section)).toEqual([]);
      expect(section.querySelector(".status-rule")?.text.trim()).toBe(
        "The customer who filed it can reopen it.",
      );
    }
  });

  it("on a team-resolved ticket offers the owner a Reopen the server accepts", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/resolve")
      .send({ reason: "wont_fix" })
      .expect(200);
    expect(actions((await statusSection(app, teamActor))!)).toEqual(["Reopen"]);
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/reopen")
      .send({ reason: "Resolved by mistake." })
      .expect(200);
    expect(actions((await statusSection(app, teamActor))!)).toEqual([
      "Ask the customer to verify",
      "Resolve",
    ]);
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

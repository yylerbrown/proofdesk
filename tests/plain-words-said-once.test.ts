import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// Small words on the pages, each said once and in the same words everywhere. Won't fix and
// Cannot reproduce take an optional note for the customer. The list's bar names Fixed as the
// ticket's own form does. The owner's Owner control offers what the rules allow, or is plain
// words. The team's edit form shows the customer's greyed check with its label
// and one line only. The read-only preview's hidden reason is a sentence of its own. On a phone
// the demo's welcome card stacks its links and Hide in one column.

const filed = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };

/** SUP-1, filed by the customer and taken and started by the team member. */
async function inProgress() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(filed);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start").expect(200);
  return built;
}

describe("resolving as Won't fix or Cannot reproduce on the page", () => {
  it("keeps the optional note for the customer, who reads it with the reason", async () => {
    for (const reason of ["wont_fix", "cannot_reproduce"]) {
      const { app } = await inProgress();
      const res = await as(app, teamActor)
        .post("/tickets/SUP-1/resolve")
        .type("form")
        .send({ reason, note: "Both invoices show the right month here." });
      expect(res.status, reason).toBe(303);
      const ticket = (await admin(app).get("/api/tickets/SUP-1")).body;
      expect(ticket.resolution, reason).toMatchObject({
        reason,
        note: "Both invoices show the right month here.",
      });
      const mine = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
      expect(mine.querySelector(".ticket-card .card-line")?.text, reason).toContain(
        "(Both invoices show the right month here).",
      );
    }
  });

  it("says nothing more when the note is left empty", async () => {
    const { app } = await inProgress();
    await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "cannot_reproduce", note: "" });
    const team = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    expect(team.querySelector(".ticket-card .card-line")?.text.trim()).toMatch(
      /^Resolved by the team: Cannot reproduce\. Team Member, .+\. The customer can reopen it\.$/,
    );
  });
});

describe("the list's bar for ticked tickets", () => {
  it("names Fixed in the resolve form's words", async () => {
    const { app } = await inProgress();
    const list = parse((await as(app, teamActor).get("/tickets")).text);
    const reasons = list.querySelectorAll("select[name=reason] option").map((o) => o.text);
    expect(reasons).toEqual([
      "Reason",
      "Fixed (the customer is told)",
      "Won't fix",
      "Cannot reproduce",
    ]);
    const form = parse((await as(app, teamActor).get("/tickets/SUP-1?step=resolve")).text);
    const fixed = form.querySelector("form.resolve input[value=fixed_no_reply]")!.parentNode!;
    expect(fixed.text.trim()).toBe(reasons[1]);
  });
});

describe("the team's edit form", () => {
  it("shows the customer's greyed check with its label and one line only", async () => {
    const { app } = await inProgress();
    const form = parse((await as(app, teamActor).get("/tickets/SUP-1/edit")).text);
    const box = form.querySelector("textarea[readonly]")!;
    const label = box.parentNode!;
    expect(label.querySelector("#fix_check-label")?.text).toBe("How will we know it's fixed?");
    expect(label.querySelector("#fix_check-hint")).toBeNull();
    expect(label.querySelector("#fix_check-locked")?.text).toBe(
      "The customer's own words. Only they can change them.",
    );
    expect(label.querySelectorAll("small")).toHaveLength(1);
    // The customer's own form still offers it as optional, with its hint.
    const own = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(own.querySelector("#fix_check-label")?.text).toBe(
      "How will we know it's fixed? (optional)",
    );
    expect(own.querySelector("#fix_check-hint")).not.toBeNull();
  });
});

describe("the Owner control for the ticket's own owner", () => {
  it("is a menu of exactly what the rules allow, and plain words when they allow nothing", async () => {
    // Another member to hand it to: the menu offers Assign to, and no Unassign once work started.
    const { app } = await inProgress();
    const page = parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
    const menu = page.querySelector(".ticket-facts details.owner-menu")!;
    expect(menu.querySelector("form.assign-to label")?.text).toContain("Assign to");
    expect(menu.text).not.toContain("Unassign");
    // On the demo nobody else on the team can take it, so the owner is plain words.
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const team = visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`);
    const demo = parse((await team.get("/tickets/SUP-3")).text);
    expect(demo.querySelector(".ticket-facts details.owner-menu")).toBeNull();
    expect(demo.querySelector(".ticket-facts .fact .fact-value")?.text).toBe("Demo Team Member");
  });
});

describe("the read-only preview's ticket page", () => {
  it("has no hidden words that start with a full stop", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    seedDemo(createTicketService(built.db, built.config.ticketPrefix));
    const page = parse(
      (await visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-admin`).get("/tickets/SUP-5"))
        .text,
    );
    const hidden = page.querySelectorAll("main .visually-hidden").map((e) => e.text.trim());
    expect(hidden).toContain("The preview is read-only.");
    for (const words of hidden) expect(words).not.toMatch(/^\./);
    // The reason is a sentence after the plain words, not inside them.
    const fact = page.querySelector(".ticket-facts .fact")!;
    expect(fact.querySelector(".visually-hidden")).toBeNull();
  });
});

describe("the About page", () => {
  it("names the menu at the top right as the way to switch, where it says how", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const main = parse((await visitor(built.app).get("/sign-in")).text).querySelector("main")!;
    expect(main.text).toContain("three made-up people with the menu at the top right.");
    expect(main.text).not.toContain("Switch role at the top");
  });
});

describe("the demo's welcome card on a phone", () => {
  it("stacks its two links and Hide in one column at the card's left edge", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const phone = css.slice(css.indexOf(" * On a phone the two links and Hide are one tidy stack"));
    const rules = phone.slice(0, phone.indexOf("\n}\n"));
    expect(rules).toContain(
      ".demo-welcome-more {\n    flex-direction: column;\n    align-items: flex-start;",
    );
    expect(rules).toContain(".demo-welcome-more .demo-welcome-hide {\n    margin-inline-start: 0;");
  });
});

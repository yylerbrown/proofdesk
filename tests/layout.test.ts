import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { showLocalTimes, type TimeElement } from "../src/browser/local-time.js";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// Where things sit on the ticket page, and how times reach the visitor. Positions on screen
// are left to the stylesheet; these tests check which part of the page holds what.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

async function ticketPage(agent: ReturnType<typeof admin>) {
  const res = await agent.get("/tickets/SUP-1");
  expect(res.status).toBe(200);
  return parse(res.text);
}

describe("the ticket page layout", () => {
  it("keeps what a person acts on in the panel and the conversation in the main part", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = await ticketPage(admin(app));
    const panel = html.querySelector("aside.ticket-panel");
    const panelLabels = panel?.querySelectorAll(".panel-label, h2").map((h) => h.text);
    // The panel holds the status and the owner. The customer's check is on the card.
    expect(panelLabels).toEqual(["Status", "Owner"]);
    expect(html.querySelector(".ticket-summary .ticket-card .card-label")?.text).toBe(
      "How will we know it's fixed?",
    );
    // Nobody owns it, so the owner's one control assigns it to the viewer.
    expect(panel?.querySelector("form[action$='/take'] button")?.text).toBe("Assign to me");
    // Everything secondary is behind one closed disclosure, last in the main column.
    expect(panel?.querySelector("details.more-options")).toBeNull();
    const more = html.querySelector(".ticket-thread > details.more-options");
    expect(html.querySelector(".ticket-thread")?.lastElementChild).toBe(more);
    expect(more?.hasAttribute("open")).toBe(false);
    expect(more?.querySelector("summary")?.text).toBe("More options");
    expect(more?.querySelectorAll("details > summary").map((el) => el.text.trim())).toEqual([
      "Offer a clearer check",
      "Attach evidence",
      "Add the code change link",
    ]);
    expect(more?.querySelectorAll(".danger-zone a").map((el) => el.text.trim())).toEqual([
      "Archive ticket",
      "Delete permanently",
    ]);
    // Edit is a quiet link, the panel's last line.
    expect(panel?.lastElementChild?.querySelector("a.edit-link")?.text).toBe("Edit ticket");
    // The next step is the card's.
    expect(
      html.querySelector(".ticket-card .next-action form[action$='/take-and-start']"),
    ).not.toBeNull();
    // The description and the conversation keep their headings for screen readers only.
    const description = html.querySelector(".ticket-summary h2")!;
    expect(description.text).toBe("Description");
    expect(description.classList.contains("visually-hidden")).toBe(true);
    expect(html.querySelector(".ticket-thread #conversation.visually-hidden")).not.toBeNull();
    expect(html.querySelector(".ticket-thread form[action$='/entries']")).not.toBeNull();
  });

  it("sets archive and permanent delete apart from the ordinary actions", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = await ticketPage(admin(app));
    const danger = html.querySelector(".danger-zone");
    expect(danger?.querySelectorAll("a.danger").map((a) => a.text)).toEqual([
      "Archive ticket",
      "Delete permanently",
    ]);
    // The last thing under More options, set apart, and nothing ordinary inside it.
    expect(html.querySelector("details.more-options")?.lastElementChild).toBe(danger);
    expect(danger?.querySelector("a[href$='/edit']")).toBeNull();
    expect(html.querySelector("a[href$='/edit']")?.classList.contains("danger")).toBe(false);
  });

  it("shows a customer no team controls, and archive without permanent delete", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = await ticketPage(as(app, customerOne));
    const panel = html.querySelector("aside.ticket-panel");
    // The customer's panel holds the status: nothing of the team's, and no owner until somebody
    // owns it. Their check is on the card.
    expect(panel?.querySelectorAll(".panel-label, h2").map((h) => h.text)).toEqual(["Status"]);
    expect(panel?.querySelector("form, button, details")).toBeNull();
    expect(html.querySelectorAll(".danger-zone a").map((a) => a.text)).toEqual(["Archive ticket"]);
  });
});

describe("times", () => {
  it("puts every exact time on the ticket page in a time element", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    await as(app, teamActor).post("/api/tickets/SUP-1/entries").send({ kind: "note", body: "x" });
    const html = await ticketPage(admin(app));
    const times = html.querySelectorAll("time");
    // One conversation entry and three history rows, the first of them the filing.
    expect(times.length).toBe(4);
    for (const time of times) {
      expect(time.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
      expect(time.text).toMatch(/ UTC$/);
    }
    // No UTC time is left outside one.
    for (const time of times) time.remove();
    expect(html.querySelector("main")?.text).not.toMatch(/\d{2}:\d{2} UTC/);
  });

  it("loads the local-time script from this site, as a module", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    const script = html.querySelector("script");
    expect(script?.getAttribute("src")).toBe("/assets/js/local-time.js");
    expect(script?.getAttribute("type")).toBe("module");
  });
});

describe("showLocalTimes", () => {
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    // A zone with no clock changes, so the answer does not depend on the time-zone data.
    timeZone: "Asia/Tokyo",
  });
  const dayFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "Asia/Tokyo",
  });
  const element = (dateTime: string, relative = false): TimeElement => ({
    dateTime,
    title: "",
    textContent: "17 Nov 2026, 20:00 UTC",
    dataset: relative ? { relative: "" } : {},
  });

  it("rewrites an exact time into the visitor's time zone", () => {
    const exact = element("2026-11-17T20:00:00.000Z");
    showLocalTimes([exact], format, dayFormat);
    expect(exact.textContent).toBe("Nov 18, 2026, 5:00 AM");
  });

  it("keeps the words of a relative time and puts the exact time on hover", () => {
    const relative = { ...element("2026-11-17T20:00:00.000Z", true), textContent: "3 hours ago" };
    showLocalTimes([relative], format, dayFormat);
    expect(relative.textContent).toBe("3 hours ago");
    expect(relative.title).toBe("Nov 18, 2026, 5:00 AM");
  });

  it("writes a time marked as a day as the visitor's own day, which can differ from UTC's", () => {
    // 20:00 UTC on the 17th is already the 18th in Tokyo.
    const day = { ...element("2026-11-17T20:00:00.000Z"), textContent: "17 Nov 2026" };
    day.dataset = { day: "" };
    showLocalTimes([day], format, dayFormat);
    expect(day.textContent).toBe("Nov 18, 2026");
  });

  it("leaves the UTC text when the time cannot be read", () => {
    const broken = element("not a time");
    showLocalTimes([broken], format, dayFormat);
    expect(broken.textContent).toBe("17 Nov 2026, 20:00 UTC");
  });
});

// The first screen shows the basics; the rest is there to find, quietly, and opens when wanted.
describe("the ticket page's quiet parts", () => {
  it("gives evidence one closed line once some exists, with no heading", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const line = async () =>
      (await ticketPage(admin(app))).querySelector(".ticket-summary details.evidence-list");
    const before = await ticketPage(admin(app));
    const more = before.querySelector("details.more-options")!;
    expect(more.querySelectorAll("summary").map((s) => s.text)).toContain("Attach evidence");
    expect(await line()).toBeNull();
    await admin(app).post("/api/tickets/SUP-1/evidence").send({ kind: "note", summary: "Checked" });
    const after = await line();
    expect(after?.querySelector("summary")?.text).toBe("Evidence (1)");
    expect(after?.hasAttribute("open")).toBe(false);
    const headings = (await ticketPage(admin(app))).querySelectorAll(".ticket-summary h2");
    expect(headings.map((h) => h.text)).toEqual(["Description"]);
  });

  it("folds the optional change link box for everyone, the owner too", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    for (const viewer of [as(app, teamActor), admin(app)]) {
      const folded = (await ticketPage(viewer))
        .querySelector("form#change-link")
        ?.closest("details");
      expect(folded?.querySelector("summary")?.text).toBe("Add the code change link");
      expect(folded?.hasAttribute("open")).toBe(false);
    }
  });
});

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
  it("is one column: status and owner under the title, the card, the conversation, the last row", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = await ticketPage(admin(app));
    const page = html.querySelector("main > .ticket-page")!;
    // No side panel and no wrapper that only made two columns.
    expect(html.querySelector("aside")).toBeNull();
    expect(html.querySelector(".ticket-panel, .ticket-layout, .ticket-summary")).toBeNull();
    // Top to bottom: the way back, the title, then status and owner on one line.
    const order = page.childNodes
      .filter((node) => node.nodeType === 1)
      .map((node) => node as unknown as { classNames: string; tagName: string })
      .map((el) => el.classNames || el.tagName.toLowerCase());
    expect(order.slice(0, 3)).toEqual(["back", "user-text", "ticket-facts"]);
    const labels = page.querySelectorAll(".ticket-facts .fact-label").map((label) => label.text);
    expect(labels).toEqual(["Status", "Owner"]);
    expect(html.querySelector(".ticket-page > .ticket-card .card-label")?.text).toBe(
      "What would prove it is fixed?",
    );
    // Nobody owns it, so the owner's menu assigns it to the viewer.
    const owner = page.querySelector(".ticket-facts details.owner-menu")!;
    expect(owner.querySelector("form[action$='/take'] button")?.text).toBe("Assign to me");
    // Everything secondary is behind one closed disclosure, last on the page.
    const lastRow = page.querySelector(".ticket-last-row")!;
    expect(page.lastElementChild).toBe(lastRow);
    const more = lastRow.querySelector("details.more-options")!;
    expect(lastRow.querySelector(".ticket-more-row")?.lastElementChild).toBe(more);
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.querySelector("summary")?.text).toBe("More options");
    expect(
      more.querySelectorAll(".more-list > li").map((el) => el.text.trim().split("\n")[0]),
    ).toEqual(["Edit ticket", "Archive ticket", "Delete permanently"]);
    // The next step is the card's.
    expect(
      html.querySelector(".ticket-card .next-action form[action$='/take-and-start']"),
    ).not.toBeNull();
    // The description and the conversation keep their headings for screen readers only.
    const description = page.querySelector("h2")!;
    expect(description.text).toBe("Description");
    expect(description.classList.contains("visually-hidden")).toBe(true);
    expect(page.querySelector("#conversation.visually-hidden")).not.toBeNull();
    expect(lastRow.querySelector("details.reply-fold form[action$='/entries']")).not.toBeNull();
  });

  it("puts archive and permanent delete last under More options, with only delete in red", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = await ticketPage(admin(app));
    const items = html.querySelectorAll("details.more-options .more-list > li");
    expect(items.slice(-2).map((li) => li.querySelector("a")?.text)).toEqual([
      "Archive ticket",
      "Delete permanently",
    ]);
    // Archiving can be undone, so it is plain.
    expect(html.querySelectorAll("a.danger").map((a) => a.text)).toEqual(["Delete permanently"]);
    expect(html.querySelector("a[href$='/edit']")?.classList.contains("danger")).toBe(false);
  });

  it("shows a customer no team controls, and archive without permanent delete", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = await ticketPage(as(app, customerOne));
    // One line of plain words under the title, with no controls.
    expect(html.querySelector(".ticket-facts")).toBeNull();
    expect(html.querySelector(".ticket-standing")?.text).toBe("New, not yet taken by the team");
    expect(html.querySelector("a[href$='/archive']")?.text).toBe("Archive ticket");
    expect(html.querySelectorAll("a.danger")).toHaveLength(0);
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
      (await ticketPage(admin(app))).querySelector(".ticket-page details.evidence-list");
    const before = await ticketPage(admin(app));
    const more = before.querySelector("details.more-options")!;
    // Evidence is added through the API and the assistants' tools; the page has no form for it.
    expect(more.querySelectorAll("summary").map((s) => s.text)).not.toContain(
      "Add evidence of the fix",
    );
    expect(await line()).toBeNull();
    await admin(app).post("/api/tickets/SUP-1/evidence").send({ kind: "note", summary: "Checked" });
    const after = await line();
    expect(after?.querySelector("summary")?.text).toBe("Evidence (1)");
    expect(after?.hasAttribute("open")).toBe(false);
    const headings = (await ticketPage(admin(app))).querySelectorAll(".ticket-page h2");
    expect(headings.map((h) => h.text)).toEqual(["Description", "Conversation"]);
  });

  it("has no change link box: a change is evidence, and a linked one is its first line", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    for (const viewer of [as(app, teamActor), admin(app)]) {
      const page = await ticketPage(viewer);
      expect(page.querySelector("form#change-link")).toBeNull();
      expect(page.text).not.toContain("Add the code change link");
      // Evidence, a linked change included, comes through the API; the page has no form for it.
      expect(page.querySelector("form[action$='/evidence']")).toBeNull();
    }
    // A change linked through the API is the first line of the one closed evidence line.
    const link = "https://example.com/change/7";
    await as(app, teamActor).put("/api/tickets/SUP-1/change-link").send({ change_url: link });
    await as(app, teamActor)
      .post("/api/tickets/SUP-1/evidence")
      .send({ kind: "note", summary: "Checked" });
    const evidence = (await ticketPage(as(app, teamActor))).querySelector(
      ".ticket-page details.evidence-list",
    )!;
    expect(evidence.hasAttribute("open")).toBe(false);
    expect(evidence.querySelector("summary")?.text).toBe("Evidence (2)");
    expect(evidence.querySelector("summary + .change-line")?.text).toBe(`Change: ${link}`);
    // It is said once: nowhere else on the page.
    expect(
      (await ticketPage(as(app, teamActor))).querySelectorAll(`a[href="${link}"]`),
    ).toHaveLength(1);
  });
});

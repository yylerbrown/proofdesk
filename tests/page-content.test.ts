import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { timeAgo, waitingOn } from "../src/server/pages/format.js";
import type { Ticket } from "../src/server/tickets/service.js";
import {
  admin,
  as,
  buildTestApp,
  customerOne,
  resolveTicket,
  signedInLine,
  teamActor,
  visitor,
} from "./helpers.js";

// What each page says and how it is put together. These tests check structure that a person
// relies on: words, labels, elements. They do not check colours or sizes.

const valid = { title: "Printer jams", description: "It jams on page two." };

async function page(agent: ReturnType<typeof admin>, url: string): Promise<HTMLElement> {
  const res = await agent.get(url).redirects(1);
  expect(res.status).toBe(200);
  return parse(res.text);
}

/** Every box a person can type in or choose from, with no label a screen reader can read. */
function unlabelled(html: HTMLElement): string[] {
  return html
    .querySelectorAll("input, textarea, select")
    .filter((field) => field.getAttribute("type") !== "hidden")
    .filter((field) => {
      if (field.getAttribute("aria-label")) return false;
      const id = field.getAttribute("id");
      if (id && html.querySelector(`label[for="${id}"]`)) return false;
      let parent = field.parentNode;
      while (parent) {
        if (parent.rawTagName === "label") return false;
        parent = parent.parentNode;
      }
      return true;
    })
    .map((field) => field.toString());
}

describe("the welcome for a signed-out visitor", () => {
  it("says what the desk is before asking anyone to sign in", async () => {
    const { app } = buildTestApp();
    const html = await page(visitor(app), "/sign-in");
    expect(html.querySelector("h1")?.text).toBe("Proofdesk");
    expect(html.querySelector("hgroup p")?.text).toContain("follow it while the team works on it");
  });

  it("offers each demo person by name alone, in the role menu it lands under", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const html = await page(visitor(app), "/tickets");
    const people = html.querySelectorAll("header .person-menu ul li.role");
    expect(people.map((li) => li.text.trim())).toEqual([
      "Demo Customer (you)",
      "Demo Team Member",
      "Demo Admin (read-only)",
    ]);
  });
});

describe("the header", () => {
  it("shows the name with the role as a quiet word, and keeps Sign out in its menu", async () => {
    const { app } = buildTestApp();
    const res = await as(app, teamActor).get("/tickets");
    expect(res.text).toContain(signedInLine("Team Member", "team"));
    const nav = parse(res.text).querySelector("header nav");
    expect(nav?.querySelector(".role-label")?.text).toBe("Team member");
    expect(nav?.querySelector(".person-menu form.sign-out button")?.text).toBe("Sign out");
    // Nothing about who is signed in is left in the page body under the header.
    expect(parse(res.text).querySelector("main form[action='/sign-out']")).toBeNull();
  });
});

describe("status badges", () => {
  it("show the status as a word inside a badge on the list and on the ticket", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const list = await page(admin(app), "/tickets");
    expect(list.querySelector("td .badge.status-new")?.text).toBe("New");
    const ticket = await page(admin(app), "/tickets/SUP-1");
    expect(ticket.querySelector("hgroup .badge.status-new")?.text).toBe("New");
  });
});

describe("the ticket list", () => {
  it("shows owner, who it waits on and the age, with the exact time in a time element", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    await admin(app)
      .post("/api/tickets")
      .send({ ...valid, title: "Taken one" });
    await as(app, teamActor).post("/api/tickets/SUP-2/take");

    const html = await page(as(app, teamActor), "/tickets");
    // A sortable header also holds its name as plain words for the phone layout; read those.
    const headings = html
      .querySelectorAll("thead th")
      .map((th) => (th.querySelector("span.sort-label") ?? th).text);
    expect(headings).toEqual(["Key", "Title", "Status", "Owner", "Waiting on", "Filed"]);
    const rows = html.querySelectorAll("tbody tr").map((tr) => tr.querySelectorAll("td"));
    expect(rows[0]?.[3]?.text).toBe("Team Member");
    expect(rows[1]?.[3]?.text).toBe("Unassigned");
    expect(rows[0]?.[4]?.text).toBe("Support team");
    const time = rows[0]?.[5]?.querySelector("time");
    expect(time?.getAttribute("datetime")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(time?.getAttribute("title")).toMatch(/ UTC$/);
    expect(time?.text).toBe("just now");
  });

  it("puts resolved tickets after the open ones", async () => {
    const { app } = buildTestApp();
    for (const title of ["One", "Two", "Three"]) {
      await as(app, customerOne)
        .post("/api/tickets")
        .send({ ...valid, title });
    }
    await resolveTicket(app, "SUP-3", customerOne);
    const html = await page(admin(app), "/tickets");
    const keys = html.querySelectorAll("tbody tr td:first-child a").map((a) => a.text);
    expect(keys).toEqual(["SUP-2", "SUP-1", "SUP-3"]);
  });

  it.each([
    ["", "There are no tickets yet."],
    ["?status=new", "No new tickets."],
    ["?status=in_progress", "Nothing is in progress."],
    ["?status=resolved", "No resolved tickets yet."],
    ["?status=archived", "Nothing is archived."],
  ])("says what is empty for the filter %s", async (query, words) => {
    const { app } = buildTestApp();
    const html = await page(admin(app), `/tickets${query}`);
    expect(html.querySelector(".empty")?.text).toContain(words);
  });

  it("tells a customer about their own tickets when they have none", async () => {
    const { app } = buildTestApp();
    const html = await page(as(app, customerOne), "/tickets");
    expect(html.querySelector(".empty")?.text).toContain("You have not filed any tickets yet.");
  });

  it("names the list in the page title", async () => {
    const { app } = buildTestApp();
    const html = await page(admin(app), "/tickets?status=in_progress");
    expect(html.querySelector("title")?.text).toBe("In Progress tickets - Proofdesk");
  });
});

describe("who is waiting", () => {
  const on = (waiting_on: string) => ({ waiting_on }) as unknown as Ticket;

  it("is said in the viewer's words", () => {
    expect(waitingOn(on("team"), "team")).toBe("Support team");
    expect(waitingOn(on("team"), "customer")).toBe("Support team");
    expect(waitingOn(on("customer"), "team")).toBe("Customer");
    expect(waitingOn(on("customer"), "customer")).toBe("You");
    expect(waitingOn(on("nobody"), "team")).toBe("Nobody");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-17T20:00:00.000Z");

  it("says how long ago in plain words", () => {
    expect(timeAgo("2026-11-17T19:59:30.000Z", now)).toBe("just now");
    expect(timeAgo("2026-11-17T19:55:00.000Z", now)).toBe("5 minutes ago");
    expect(timeAgo("2026-11-17T17:00:00.000Z", now)).toBe("3 hours ago");
    expect(timeAgo("2026-11-16T20:00:00.000Z", now)).toBe("yesterday");
    expect(timeAgo("2026-10-01T20:00:00.000Z", now)).toBe("last month");
  });
});

describe("the ticket page", () => {
  it("shows display names in the history, not ids", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    await as(app, teamActor).post("/api/tickets/SUP-1/take");
    const html = await page(as(app, teamActor), "/tickets/SUP-1");
    const who = html
      .querySelectorAll("table")
      .at(-1)
      ?.querySelectorAll("tbody td:last-child")
      .map((td) => td.text);
    // Each name with its role beside it.
    expect(who).toEqual(["Customer One customer", "Team Member team"]);
  });

  it("has the key and the title in the page title", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const html = await page(admin(app), "/tickets/SUP-1");
    expect(html.querySelector("title")?.text).toBe("SUP-1: Printer jams - Proofdesk");
  });

  it("gives every box a label, for the team and for the customer", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    expect(unlabelled(await page(admin(app), "/tickets/SUP-1"))).toEqual([]);
    expect(unlabelled(await page(as(app, customerOne), "/tickets/SUP-1"))).toEqual([]);
    expect(unlabelled(await page(admin(app), "/tickets/new"))).toEqual([]);
    expect(unlabelled(await page(admin(app), "/tickets/SUP-1/edit"))).toEqual([]);
  });
});

describe("after a save", () => {
  it("says what was saved on the next page, once", async () => {
    const { app } = buildTestApp();
    const browser = as(app, teamActor);
    const filed = await browser.post("/tickets").type("form").send(valid);
    expect(filed.status).toBe(303);
    const shown = parse((await browser.get("/tickets/SUP-1")).text);
    // The receipt names the ticket and says what happens next.
    expect(shown.querySelector("[role=status]")?.text).toBe(
      "Ticket SUP-1 filed. The support team has it now; come back to this page for updates.",
    );
    const again = parse((await browser.get("/tickets/SUP-1")).text);
    expect(again.querySelector("[role=status]")).toBeNull();
  });

  it("names a note as a note and a reply as a reply", async () => {
    const { app } = buildTestApp();
    const browser = as(app, teamActor);
    await admin(app).post("/api/tickets").send(valid);
    await browser.post("/tickets/SUP-1/entries").type("form").send({ kind: "note", body: "Hi" });
    expect((await browser.get("/tickets/SUP-1")).text).toContain("Internal note added.");
    await browser.post("/tickets/SUP-1/entries").type("form").send({ kind: "reply", body: "Hi" });
    expect((await browser.get("/tickets/SUP-1")).text).toContain("Reply sent.");
  });

  it("shows nothing for a word that is not one of its own", async () => {
    const { app } = buildTestApp();
    await admin(app).post("/api/tickets").send(valid);
    const res = await admin(app)
      .get("/tickets/SUP-1")
      .set("Cookie", "dev_actor=dev-admin-1; saved=<b>hi</b>");
    expect(parse(res.text).querySelector("[role=status]")).toBeNull();
    expect(res.text).not.toContain("<b>hi</b>");
  });
});

import { HTMLElement, parse } from "node-html-parser";
import request from "supertest";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { keyOnPage } from "./key-on-page.js";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import { firstParagraph } from "../src/server/pages/format.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  handToAgent,
  teamActor,
  visitor,
} from "./helpers.js";

// The ticket page's Owner is one small menu, its More options holds only the rarer steps, an
// assistant's long note is folded after its first paragraph, and the page uses one name per idea.

const valid = {
  title: "Printer jams",
  description: "It jams on page two.",
  fix_check: "Ten pages print",
};

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

async function page(app: Express, who = teamActor): Promise<HTMLElement> {
  return parse((await as(app, who).get("/tickets/SUP-1")).text);
}

/** Posts a ticket-page form as the team member, then reads the message on the page it leads to. */
async function savedAfter(app: Express, path: string, fields: object) {
  const res = await as(app, teamActor).post(path).type("form").send(fields);
  expect(res.status).toBe(303);
  const next = await visitor(app)
    .set("Cookie", [`${DEV_COOKIE}=${teamActor.id}`, ...[res.headers["set-cookie"]].flat()])
    .get(res.headers.location!);
  return parse(next.text).querySelector("p.saved")?.text.trim();
}

/** The names of what the open Owner menu offers, in order. */
function ownerChoices(html: HTMLElement): string[] {
  const list = html.querySelector(".ticket-facts details.owner-menu > ul");
  if (list === null) return [];
  return list
    .querySelectorAll("li")
    .map((item) => (item.querySelector("label")?.text ?? item.text).trim())
    .map((name) => name.split("\n")[0]!.trim());
}

describe("the Owner menu", () => {
  it("is the owner's name, which opens what the rules allow, posting to the same routes", async () => {
    const { app } = await filed();
    // Nobody owns it: the team member can assign it to themselves.
    const unowned = await page(app);
    const control = unowned.querySelector(".ticket-facts details.owner-menu")!;
    expect(control.hasAttribute("open")).toBe(false);
    expect(control.querySelector("summary .fact-label")?.text).toBe("Owner");
    expect(control.querySelector("summary .fact-value")?.text).toBe("Unassigned");
    expect(ownerChoices(unowned)).toEqual(["Assign to me"]);
    expect(control.querySelector("form[action='/tickets/SUP-1/take']")).not.toBeNull();

    // Its owner, on a New ticket, can assign it to someone else or unassign it.
    await as(app, teamActor).post("/tickets/SUP-1/take").type("form").send({});
    const owned = await page(app);
    expect(owned.querySelector(".owner-menu summary .fact-value")?.text).toBe("Team Member");
    expect(ownerChoices(owned)).toEqual(["Assign to", "Unassign"]);
    expect(
      owned.querySelector(".owner-menu form[action='/tickets/SUP-1/hand-off']"),
    ).not.toBeNull();
    expect(owned.querySelector(".owner-menu form[action='/tickets/SUP-1/release']")).not.toBeNull();

    // The old separate controls are gone, from the top and from More options.
    const text = owned.querySelector("main")!.text;
    for (const gone of ["Hand off to", "Release it", "Team member"]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(owned.querySelectorAll("form[action='/tickets/SUP-1/release']")).toHaveLength(1);

    // The customer sees the owner as plain words, with nothing to press.
    const customer = await page(app, customerOne);
    expect(customer.querySelector("details.owner-menu")).toBeNull();
    expect(customer.querySelector(".ticket-standing")?.text).toBe("New, with Team Member");
  });

  it("is plain words for a team member who may change nothing", async () => {
    const { app } = await filed();
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    const other = await page(app);
    expect(other.querySelector("details.owner-menu")).toBeNull();
    const owner = other.querySelectorAll(".ticket-facts .fact").at(-1)!;
    expect(owner.text.replace(/\s+/g, " ").trim()).toBe("Owner Admin");
  });

  it("opens on its message after a refused change", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/tickets/SUP-1/take").type("form").send({});
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/hand-off")
      .type("form")
      .send({ to: "" });
    expect(refused.status).toBe(400);
    const html = parse(refused.text);
    const control = html.querySelector(".ticket-facts details.owner-menu")!;
    expect(control.hasAttribute("open")).toBe(true);
    expect(control.querySelector("#hand-off-error")?.text).toBe("Choose a team member.");
  });

  it("says each change with the same words", async () => {
    const { app } = await filed();
    expect(await savedAfter(app, "/tickets/SUP-1/take", {})).toBe("Assigned to you.");
    expect(await savedAfter(app, "/tickets/SUP-1/release", {})).toBe(
      "Unassigned. Anyone on the team can take it.",
    );
    const history = (await page(app))
      .querySelectorAll("details.history tbody tr")
      .map((row) => row.querySelectorAll("td")[1]!.text);
    expect(history).toContain("Assigned to Team Member");
    expect(history).toContain("Unassigned");
  });
});

describe("More options", () => {
  it("holds, in order, Edit, Add evidence and Ask with details, then Archive and Delete", async () => {
    const { app } = await filed();
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    const more = (await page(app, adminActor)).querySelector("details.more-options")!;
    // Each thing it holds is one closed line, by the name it shows while More options is open.
    const names = more.querySelectorAll(".more-list > li").map((item) => {
      const line = item.querySelector("summary") ?? item.querySelector("a, button")!;
      return line.text.trim();
    });
    expect(names).toEqual([
      "Edit ticket",
      "Add evidence",
      "Ask with details",
      "Archive ticket",
      "Delete permanently",
    ]);
    // Only one of them is open at a time.
    const folds = more.querySelectorAll(".more-list details");
    expect(folds.map((fold) => fold.getAttribute("name"))).toEqual(["more-option", "more-option"]);
    expect(more.text).not.toContain("Offer a clearer check");
    expect(more.text).not.toContain("code change link");
  });

  it("adds a change as evidence, with its link", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const form = (await page(app)).querySelector("form[action='/tickets/SUP-1/evidence']")!;
    expect(form.querySelector("button[type=submit]")?.text).toBe("Add evidence");
    const added = await savedAfter(app, "/tickets/SUP-1/evidence", {
      kind: "change_link",
      summary: "The fix",
      link: "https://example.com/pull/9",
    });
    expect(added).toMatch(/^Evidence added\./);
    const html = await page(app);
    const evidence = html.querySelector("details.evidence-list")!;
    expect(evidence.querySelector("summary")?.text).toBe("Evidence (1)");
    expect(evidence.text).toContain("Change:");
    expect(evidence.querySelector("a")?.getAttribute("href")).toBe("https://example.com/pull/9");
  });
});

async function assistantNote(body: string) {
  const built = await filed();
  const res = await admin(built.app)
    .post("/connections")
    .type("form")
    .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
  const key = keyOnPage(res.text);
  await handToAgent(built.app, "SUP-1", key);
  const note = await request(built.app)
    .post("/api/tickets/SUP-1/notes")
    .set("Authorization", `Bearer ${key}`)
    .send({ body });
  expect(note.status).toBe(201);
  return built;
}

describe("an assistant's long note", () => {
  it("shows its first paragraph and folds the rest under one line", async () => {
    const { app } = await assistantNote("Ran the tests.\n\nAll ten passed.\n\nThe fix is ready.");
    const entry = (await page(app, adminActor)).querySelector(".ticket-page article.entry.note")!;
    expect(entry.querySelector(":scope > p.user-text")?.text).toBe("Ran the tests.");
    const fold = entry.querySelector("details.note-rest")!;
    expect(fold.hasAttribute("open")).toBe(false);
    expect(fold.querySelector("summary")?.text).toBe("Show the full note");
    expect(fold.querySelector("p")?.text).toBe("All ten passed.\n\nThe fix is ready.");
    expect(entry.querySelector(".tag")?.text).toBe("AI assistant");
  });

  it("is whole when it is one paragraph, and a person's note is always whole", async () => {
    const { app } = await assistantNote("One short paragraph.");
    await admin(app)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({ kind: "note", body: "First.\n\nSecond." });
    const notes = (await page(app, adminActor)).querySelectorAll(".ticket-page article.entry.note");
    expect(notes.map((note) => note.querySelector("details.note-rest"))).toEqual([null, null]);
    expect(notes[1]!.querySelector("p.user-text")?.text).toBe("First.\n\nSecond.");
  });

  it("splits at the first blank line, whatever the line endings", () => {
    expect(firstParagraph("One\r\n\r\nTwo\r\n\r\nThree")).toEqual({
      first: "One",
      rest: "Two\n\nThree",
    });
    expect(firstParagraph("One\nstill one")).toEqual({ first: "One\nstill one", rest: null });
    expect(firstParagraph("One\n \n")).toEqual({ first: "One", rest: null });
  });
});

describe("History", () => {
  it("is the table alone, with no link to an empty notices page", async () => {
    const { app } = await filed();
    const notices = (html: HTMLElement) =>
      html.querySelectorAll("details.more-options a[href='/tickets/SUP-1/notices']");
    for (const who of [teamActor, customerOne]) {
      const html = await page(app, who);
      const history = html.querySelector("details.history")!;
      expect(history.hasAttribute("open")).toBe(false);
      expect(history.querySelectorAll("a")).toHaveLength(0);
      // Nothing was sent yet, so there is no link to an empty page.
      expect(notices(html)).toHaveLength(0);
    }
  });
});

describe("one name per idea on the demo's ticket pages", () => {
  it("never says AI agent, spec or the way to test, outside what people and assistants wrote", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    const views: [string, string][] = [
      ["demo-customer", "SUP-5"],
      ["demo-team", "SUP-8"],
      ["demo-team", "SUP-7"],
      ["demo-team", "SUP-6"],
      ["demo-team", service.recordedRunKey()!],
      ["demo-team", "SUP-3"],
      ["demo-admin", "SUP-3"],
    ];
    for (const [id, key] of views) {
      const res = await visitor(built.app)
        .set("Cookie", `${DEV_COOKIE}=${id}`)
        .get(`/tickets/${key}`);
      const html = parse(res.text);
      for (const written of html.querySelectorAll(".user-text, code, textarea")) written.remove();
      const text = html.querySelector("body")!.text;
      for (const gone of [/AI agent/, /\bspec\b/i, /way to test/, /says it is fixed/]) {
        expect(text, `${id} on ${key}`).not.toMatch(gone);
      }
    }
  });

  it("seeds no team's check on the demo", async () => {
    const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const service = createTicketService(built.db, built.config.ticketPrefix);
    seedDemo(service);
    const sup3 = await visitor(built.app)
      .set("Cookie", `${DEV_COOKIE}=demo-team`)
      .get("/api/tickets/SUP-3");
    expect(sup3.body.agreed_check).toBeNull();
    expect(
      parse(
        (await visitor(built.app).set("Cookie", `${DEV_COOKIE}=demo-team`).get("/tickets/SUP-3"))
          .text,
      ).querySelector(".card-team-check"),
    ).toBeNull();
  });
});

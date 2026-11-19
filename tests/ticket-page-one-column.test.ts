import fs from "node:fs";
import { parse, type HTMLElement } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_ACTORS } from "../src/server/actor.js";
import { collectNotices, type NotifySettings } from "../src/server/notify/outbox.js";
import { customerStanding } from "../src/server/pages/standing.js";
import { AGENT_SCOPES } from "../src/server/permissions.js";
import type { Ticket } from "../src/server/tickets/service.js";
import { keyOnPage } from "./key-on-page.js";
import { giveAddresses } from "./notify-life.js";
import {
  admin,
  adminActor,
  as,
  buildTestApp,
  customerOne,
  handToAgent,
  resolveTicket,
  teamActor,
} from "./helpers.js";

// The ticket page is one centred column: the title, status and owner on one line under it, the
// ticket's words, the customer's check, where it stands, the one next step, the conversation,
// and a quiet last row with the message box, History and More options. Resolving from the
// Status menu shows one small form in the next step's place.

const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: "Prints" };

async function filed() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  return built;
}

const page = async (app: Express, who = teamActor, at = "/tickets/SUP-1") =>
  parse((await as(app, who).get(at)).text);

const css = fs.readFileSync("public/site.css", "utf8");
const theme = fs.readFileSync("public/theme.css", "utf8");

/** The declarations of the first rule whose selector is exactly this one. */
function ruleFor(selector: string): string {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const found of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (found[1]!.trim() === selector) return found[2]!;
  }
  throw new Error(`No rule for ${selector}`);
}

describe("the column", () => {
  it("is one reading width, centred under the header, from the shared column token", () => {
    expect(theme).toMatch(/--pd-column: 44rem;/);
    const column = ruleFor(".ticket-page");
    expect(column).toContain("max-width: var(--pd-column);");
    expect(column).toContain("margin-inline: auto;");
    // The line saying what was saved starts on the same left edge.
    expect(ruleFor("main:has(> .ticket-page) > :is(p.saved, p.refused)")).toContain(
      "margin-left: calc((100% - min(100%, var(--pd-column))) / 2);",
    );
  });

  it("has no side panel left in the stylesheet, and the check sits on the page's background", () => {
    expect(css).not.toMatch(/\.ticket-panel|\.ticket-layout|\.ticket-summary|--pd-rail/);
    expect(theme).not.toContain("--pd-rail");
    const card = ruleFor("article.ticket-card");
    expect(card).toContain("border: 0;");
    expect(card).toContain("background: none;");
  });

  it("draws its one hairline where the conversation begins, only when there is one", async () => {
    const { app } = await filed();
    expect((await page(app)).querySelector("hr")).toBeNull();
    await as(app, customerOne)
      .post("/api/tickets/SUP-1/entries")
      .send({ kind: "reply", body: "Hi" });
    const html = await page(app);
    const rule = html.querySelectorAll(".ticket-page hr");
    expect(rule).toHaveLength(1);
    expect(rule[0]!.classList.contains("thread-start")).toBe(true);
    expect(rule[0]!.nextElementSibling?.id).toBe("conversation");
  });
});

describe("the customer's line under the title", () => {
  const ticket = (fields: Partial<Ticket>) =>
    ({ status: "new", owner_name: null, resolution: null, ...fields }) as Ticket;

  it("says where it stands and whose turn it is, in plain words", () => {
    expect(customerStanding(ticket({}), false)).toEqual({
      text: "New, not yet taken by the team",
      tick: false,
    });
    expect(customerStanding(ticket({ owner_name: "Sam" }), false).text).toBe("New, with Sam");
    expect(customerStanding(ticket({ status: "in_progress", owner_name: "Sam" }), false).text).toBe(
      "In Progress, with Sam",
    );
    const byTeam = { by: "team" } as Ticket["resolution"];
    expect(customerStanding(ticket({ status: "resolved", resolution: byTeam }), false)).toEqual({
      text: "Resolved by the team",
      tick: false,
    });
  });

  it("carries the tick only for the customer's own Yes", async () => {
    expect(customerStanding({ status: "resolved" } as Ticket, true)).toEqual({
      text: "Resolved, customer confirmed",
      tick: true,
    });
    const { app } = await filed();
    await resolveTicket(app, "SUP-1", customerOne);
    const standing = (await page(app, customerOne)).querySelector(".ticket-standing")!;
    expect(standing.text).toBe("Resolved, customer confirmed");
    expect(standing.querySelector("img.tick")?.getAttribute("alt")).toBe("");
  });
});

describe("the Status and Owner menus", () => {
  it("are native fold-opens that share one name, so only one is open, wired to close like the person menu", async () => {
    const { app } = await filed();
    const menus = (await page(app)).querySelectorAll(".ticket-facts > details.fact-menu");
    expect(menus.map((menu) => menu.classList.contains("status-menu"))).toEqual([true, false]);
    expect(menus.map((menu) => menu.getAttribute("name"))).toEqual([
      "ticket-facts",
      "ticket-facts",
    ]);
    const script = fs.readFileSync("src/browser/menus.ts", "utf8");
    expect(script).toContain('"details.person-menu, details.fact-menu"');
  });

  it("list exactly New, In Progress and Resolved, the current one marked and not pressable", async () => {
    const { app } = await filed();
    const items = (await page(app)).querySelectorAll(".status-menu > ul > li");
    expect(items.map((item) => item.text.trim())).toEqual([
      "New",
      "In Progress (assigns it to you)",
      "Resolved",
    ]);
    const current = items[0]!.querySelector('[aria-current="true"]')!;
    expect(current.tagName).toBe("SPAN");
    expect(items[0]!.querySelector("a, button")).toBeNull();
  });

  it("show a handed-over ticket's assistant, and the way to stop it, in the Owner menu", async () => {
    const { app } = await filed();
    const res = await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
    await handToAgent(app, "SUP-1", keyOnPage(res.text));
    const owner = (await page(app, adminActor)).querySelector(".owner-menu")!;
    expect(owner.querySelector(".agent-help")?.text).toMatch(
      /^Handed to Helper \(AI assistant\), since /,
    );
    expect(owner.querySelector("form[action$='/agent/end'] button")?.text).toBe(
      "Stop the assistant",
    );
  });
});

describe("resolving from the Status menu", () => {
  const resolvePage = (app: Express) => page(app, teamActor, "/tickets/SUP-1?step=resolve");

  it("is a link to the same page with one small form in the next step's place", async () => {
    const { app } = await filed();
    const plain = await page(app);
    const link = plain.querySelector(".status-menu a")!;
    expect(link.getAttribute("href")).toBe("/tickets/SUP-1?step=resolve");
    expect(plain.querySelector("form.resolve")).toBeNull();

    const html = await resolvePage(app);
    const form = html.querySelector(".ticket-card form#resolve-form")!;
    expect(form.querySelector("legend")?.text).toBe("Why are you resolving this ticket?");
    const choices = form.querySelectorAll("fieldset label").map((label) => label.text.trim());
    expect(choices).toEqual([
      "Fixed. Not customer-confirmed.",
      "Duplicate of another ticket",
      "Won't fix",
      "Cannot reproduce",
      "Other",
    ]);
    expect(form.querySelector("select")).toBeNull();
    // The first choice takes focus, and nothing is chosen for the visitor.
    expect(form.querySelector("input[autofocus]")?.getAttribute("value")).toBe("fixed_no_reply");
    expect(form.querySelector(".form-actions button")?.text).toBe("Resolve ticket");
    expect(form.querySelector(".form-actions a")?.getAttribute("href")).toBe("/tickets/SUP-1");
    expect(form.querySelector(".form-actions a")?.text).toBe("Cancel");
    // While it shows, the usual next step does not.
    expect(html.querySelector(".next-action")).toBeNull();
  });

  it("keeps the choice and the text when it is refused", async () => {
    const { app } = await filed();
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/resolve")
      .type("form")
      .send({ reason: "duplicate", duplicate_of: "SUP-99" });
    expect(refused.status).toBe(400);
    const form = parse(refused.text).querySelector("form#resolve-form")!;
    expect(form.querySelector("input[checked]")?.getAttribute("value")).toBe("duplicate");
    expect(form.querySelector("input[name=duplicate_of]")?.getAttribute("value")).toBe("SUP-99");
    expect(form.querySelector("#resolve-error")?.text).not.toBe("");
  });
});

describe("the last row", () => {
  it("holds the closed message box, then History and More options", async () => {
    const { app } = await filed();
    for (const [who, words] of [
      [teamActor, "Reply or add a note"],
      [customerOne, "Write a message"],
    ] as const) {
      const row = (await page(app, who)).querySelector(".ticket-page > .ticket-last-row")!;
      const lines = row.querySelectorAll(":scope > details > summary").map((s) => s.text.trim());
      expect(lines).toEqual([words, "History (1)", "More options"]);
      const box = row.querySelector("details.reply-fold")!;
      expect(box.hasAttribute("open")).toBe(false);
      expect(box.querySelector("textarea#entry-body")).not.toBeNull();
    }
  });

  it("says in note mode that only the team can see it, and opens the box on a refused message", async () => {
    const { app } = await filed();
    const html = await page(app);
    expect(html.querySelector("form.reply-box .note-hint")?.text).toBe(
      "Only the team can see this.",
    );
    expect(ruleFor('form.reply-box:not(:has(input[value="note"]:checked)) .note-hint')).toContain(
      "visibility: hidden;",
    );
    expect((await page(app, customerOne)).querySelector(".note-hint")).toBeNull();
    const refused = await as(app, teamActor)
      .post("/tickets/SUP-1/entries")
      .type("form")
      .send({ kind: "reply", body: "" });
    expect(refused.status).toBe(400);
    expect(parse(refused.text).querySelector("details.reply-fold")?.hasAttribute("open")).toBe(
      true,
    );
  });
});

describe("More options", () => {
  /** Each line of More options, by the name it shows. */
  const lines = (html: HTMLElement) =>
    html
      .querySelectorAll("details.more-options .more-list > li")
      .map((item) =>
        (item.querySelector("summary") ?? item.querySelector("a, button"))!.text.trim(),
      );

  it("holds, in order, every rare step this viewer may take, and the notices once there are some", async () => {
    const { app, db } = await filed();
    giveAddresses(db);
    await admin(app)
      .post("/connections")
      .type("form")
      .send({ name: "Helper", scopes: [...AGENT_SCOPES] });
    await admin(app).post("/api/tickets/SUP-1/take-and-start");
    expect(lines(await page(app, adminActor))).toEqual([
      "Edit ticket",
      "Add evidence",
      "Ask with details",
      "Hand to an AI assistant",
      "Archive ticket",
      "Delete permanently",
    ]);
    // Once the customer is asked, the question can be withdrawn and nothing is handed over.
    await admin(app).post("/api/tickets/SUP-1/ready").send({});
    const settings: NotifySettings = {
      ticketPrefix: "SUP",
      siteUrl: "https://desk.test",
      demo: false,
      mailConfigured: true,
      madeUpPeople: [],
      roleNow: (_db, id) => DEV_ACTORS.find((person) => person.id === id)?.role,
    };
    collectNotices(db, settings);
    expect(lines(await page(app, adminActor))).toEqual([
      "Edit ticket",
      "Add evidence",
      "Withdraw the question",
      "Email notices",
      "Archive ticket",
      "Delete permanently",
    ]);
  });

  it("asks for evidence with two boxes, and picks the kind from the link", async () => {
    const { app } = await filed();
    const form = (await page(app)).querySelector("form[action='/tickets/SUP-1/evidence']")!;
    const boxes = form.querySelectorAll("label").map((label) => label.text.trim().split("\n")[0]);
    expect(boxes).toEqual(["What does it show?", "Link (optional)"]);
    expect(form.querySelector("select, [name=kind]")).toBeNull();
    const add = (fields: object) =>
      as(app, teamActor).post("/tickets/SUP-1/evidence").type("form").send(fields).expect(303);
    await add({ summary: "Printed ten pages", link: "" });
    await add({ summary: "The fix", link: "https://example.com/pull/9" });
    const kinds = (await as(app, teamActor).get("/api/tickets/SUP-1/evidence")).body.map(
      (item: { kind: string }) => item.kind,
    );
    expect(kinds).toEqual(["check_run", "change_link"]);
  });

  it("asks with details in one box, which the customer reads with the question", async () => {
    const { app } = await filed();
    await as(app, teamActor).post("/api/tickets/SUP-1/take-and-start");
    const form = (await page(app)).querySelector("details#ask form")!;
    const box = form.querySelector("textarea[name=response]")!;
    expect(box.parentNode!.text.trim().split("\n")[0]).toBe("Message to the customer (optional)");
    expect(form.querySelectorAll("input:not([type=hidden]), textarea, select")).toHaveLength(1);
    await as(app, teamActor)
      .post("/tickets/SUP-1/ready")
      .type("form")
      .send({
        response: "It is live now.",
        expected_version: box
          .closest("form")!
          .querySelector("input[name=expected_version]")!
          .getAttribute("value")!,
      })
      .expect(303);
    const question = (await page(app, customerOne)).querySelector("#did-this-fix-it")!;
    expect(question.text).toContain("Team Member wrote:");
    expect(question.text).toContain("It is live now.");
    expect(question.text).not.toContain("since you said it still fails");
  });
});

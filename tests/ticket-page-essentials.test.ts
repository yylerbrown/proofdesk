import fs from "node:fs";
import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The ticket page, reduced: each viewer sees the one next thing to do, the customer's words once,
// and the conversation. Everything secondary is collapsed or behind one "More options".

const words = "Ten pages print without a jam";
const valid = { title: "Printer jams", description: "It jams on page two.", fix_check: words };

async function inProgress() {
  const built = buildTestApp();
  await as(built.app, customerOne).post("/api/tickets").send(valid);
  await as(built.app, teamActor).post("/api/tickets/SUP-1/take-and-start");
  await admin(built.app)
    .post("/api/tickets/SUP-1/evidence")
    .send({ kind: "check_run", summary: "Printed ten pages twice" });
  return built;
}

async function asked(app: Express) {
  await as(app, teamActor)
    .put("/api/tickets/SUP-1/change-link")
    .send({ change_url: "https://example.com/c" });
  await as(app, teamActor)
    .post("/api/tickets/SUP-1/ready")
    .send({ try_url: "https://example.com/t", tried: "Printed.", result: "No jam." });
}

const page = async (app: Express, who: typeof teamActor) =>
  parse((await as(app, who).get("/tickets/SUP-1")).text);
const shown = (html: ReturnType<typeof parse>, text: string) =>
  html.querySelector("main")!.text.split(text).length - 1;

describe("the customer's ticket page", () => {
  it("holds their words, the status and owner in one line, Edit under More options, nothing of the team's", async () => {
    const { app } = await inProgress();
    const html = await page(app, customerOne);
    expect(html.querySelector(".back")?.text.trim()).toBe("My tickets / SUP-1");
    // Where it stands and whose turn it is, in plain words, with nothing to press.
    const standing = html.querySelector(".ticket-standing")!;
    expect(standing.text).toBe("In Progress, with Team Member");
    expect(standing.querySelector("a, button, details, form")).toBeNull();
    // Their words are under the check's small label, once.
    expect(html.querySelector(".ticket-card blockquote")?.text).toBe(words);
    expect(shown(html, words)).toBe(1);
    expect(html.querySelector("main")!.text).not.toContain("Printed ten pages twice");
    expect(
      html
        .querySelector("details.more-options")
        ?.querySelectorAll("a")
        .map((a) => a.text),
    ).toEqual(["Edit ticket", "Archive ticket"]);
  });

  it("shows the check once while they are asked: in the question, not again beside it", async () => {
    const { app } = await inProgress();
    await asked(app);
    const html = await page(app, customerOne);
    expect(html.querySelector("#did-this-fix-it")?.text).toContain(words);
    expect(shown(html, words)).toBe(1);
    expect(html.querySelector(".ticket-standing")?.text).toBe("In Progress, with Team Member");
  });
});

describe("the team's ticket page", () => {
  it("keeps the next action in view and puts the secondary ones in More options, opened by keyboard", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = await page(app, teamActor);
    const top = html.querySelector(".ticket-facts")!;
    expect(html.querySelector(".next-action button")?.text).toBe("Take ticket and start work");
    // A native details element: a summary a keyboard can open, with the actions inside it.
    const more = html.querySelector(".ticket-last-row details.more-options")!;
    expect(more.firstElementChild?.tagName).toBe("SUMMARY");
    expect(more.firstElementChild?.text).toBe("More options");
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.querySelector("details > summary")?.text).toBe("Add evidence");
    // The owner's menu is in the line under the title, and nothing secondary is.
    expect(top.querySelectorAll(".owner-menu form[action$='/take']")).toHaveLength(1);
    expect(top.querySelector("details.more-options")).toBeNull();
    expect(top.querySelector("a[href$='/edit']")).toBeNull();
  });

  it("folds the evidence list and an existing change link away", async () => {
    const { app } = await inProgress();
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const html = await page(app, teamActor);
    const evidence = html.querySelector("details.evidence-list")!;
    expect(evidence.hasAttribute("open")).toBe(false);
    // The change counts as evidence and is its first line; the page has no form to change it.
    expect(evidence.querySelector("summary")?.text).toBe("Evidence (2)");
    expect(evidence.querySelector(".change-line")?.text).toBe("Change: https://example.com/c");
    expect(evidence.text).toContain("Printed ten pages twice");
    expect(html.querySelector("form[action$='/change-link']")).toBeNull();
  });
});

describe("the small controls on a phone", () => {
  it("are 44-pixel tap targets there: History, Status and Owner, the message box, More options and Copy", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const phone = [...css.matchAll(/@media \(max-width: 639px\) \{([\s\S]*?)\n\}/g)].map(
      (m) => m[1]!,
    );
    const rule = (selector: RegExp) =>
      phone.some((block) =>
        new RegExp(`${selector.source}[^{]*\\{[^}]*min-height: 44px`).test(block),
      );
    expect(rule(/details\.history > summary/)).toBe(true);
    expect(rule(/\.ticket-facts details\.dropdown\.fact-menu > summary/)).toBe(true);
    // The closed message line, drawn as a text box.
    expect(rule(/details\.reply-fold:not\(\[open\]\) > summary/)).toBe(true);
    expect(rule(/details\.more-options summary/)).toBe(true);
    expect(rule(/button\.copy/)).toBe(true);
  });
});

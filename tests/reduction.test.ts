import fs from "node:fs";
import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { admin, as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// The ticket page, reduced: each viewer sees the one next thing to do, the customer's words once,
// and the conversation. Everything secondary is collapsed or in one small "More" menu.

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
  it("holds their words, the owner and status under the title, and a small menu, nothing of the team's", async () => {
    const { app } = await inProgress();
    const html = await page(app, customerOne);
    expect(html.querySelector("hgroup .meta")?.text).toMatch(
      /^SUP-1 In Progress · Owner Team Member · filed /,
    );
    const panel = html.querySelector("aside.ticket-panel")!;
    expect(panel.querySelectorAll("h2").map((h) => h.text)).toEqual([
      "How will we know it's fixed?",
    ]);
    expect(panel.text).not.toContain("Printed ten pages twice");
    expect(
      panel
        .querySelector("details.more")
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
    expect(html.querySelector("hgroup .meta")?.text).toContain("In Progress, waiting for you");
  });
});

describe("the team's ticket page", () => {
  it("keeps the next action in view and puts the secondary ones in More, opened by keyboard", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(valid);
    const html = await page(app, teamActor);
    const panel = html.querySelector("aside.ticket-panel")!;
    expect(html.querySelector(".next-action button")?.text).toBe("Take ticket and start work");
    // A native details element: a summary a keyboard can open, with the actions inside it.
    const more = panel.querySelector("details.more")!;
    expect(more.firstElementChild?.tagName).toBe("SUMMARY");
    expect(more.hasAttribute("open")).toBe(false);
    expect(more.querySelector("form[action$='/take'] button")?.text).toBe("Take this ticket");
    expect(more.querySelector("a[href$='/edit']")?.text).toBe("Edit ticket");
    expect(panel.querySelectorAll("section form[action$='/take']")).toHaveLength(0);
  });

  it("folds the evidence list and an existing change link away", async () => {
    const { app } = await inProgress();
    await as(app, teamActor)
      .put("/api/tickets/SUP-1/change-link")
      .send({ change_url: "https://example.com/c" });
    const html = await page(app, teamActor);
    const evidence = html.querySelector("details.evidence-list")!;
    expect(evidence.hasAttribute("open")).toBe(false);
    expect(evidence.querySelector("summary")?.text).toBe("1 piece, as reported");
    expect(evidence.text).toContain("Printed ten pages twice");
    const change = html.querySelector("details.change-link")!;
    expect(change.querySelector("summary")?.text).toBe("Change the link");
    expect(change.querySelector("form[action$='/change-link']")).not.toBeNull();
  });
});

describe("the More control", () => {
  it("is a full-size tap target, at least 44 pixels high", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toMatch(/details\.more > summary \{[^}]*min-height: 44px/);
  });
});

describe("the small controls on a phone", () => {
  it("are 44-pixel tap targets there, like More: History, the panel's disclosures and Copy", () => {
    const css = fs.readFileSync("public/site.css", "utf8");
    const phone = [...css.matchAll(/@media \(max-width: 639px\) \{([\s\S]*?)\n\}/g)].map(
      (m) => m[1]!,
    );
    const rule = (selector: RegExp) =>
      phone.some((block) =>
        new RegExp(`${selector.source}[^{]*\\{[^}]*min-height: 44px`).test(block),
      );
    expect(rule(/details\.history > summary/)).toBe(true);
    expect(rule(/\.ticket-panel details:not\(\.more\) > summary/)).toBe(true);
    expect(rule(/button\.copy/)).toBe(true);
  });
});

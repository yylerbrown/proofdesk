import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, teamActor } from "./helpers.js";

// "This is the current one" looks the same on the ticket list and on the ticket page: the
// list's selected filter and the ticket's current status share one rule of the stylesheet, a
// grey box with a strong edge, while the status buttons beside it stay white. The resolve form
// starts by saying what pressing it will do.

const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The selectors and declarations of the one rule whose selectors end with this one. */
function ruleEndingWith(selector: string): { selectors: string; body: string } {
  for (const found of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = found[1]!.replace(/\s+/g, " ").trim();
    if (selectors.endsWith(selector)) return { selectors, body: found[2]! };
  }
  throw new Error(`No rule for ${selector}`);
}

async function ticketPage() {
  const { app } = buildTestApp();
  await as(app, customerOne)
    .post("/api/tickets")
    .send({ title: "Printer jams", description: "It jams on page two." });
  return parse((await as(app, teamActor).get("/tickets/SUP-1")).text);
}

describe("the current status on a ticket page", () => {
  it("is marked with the class that shares the list's selected look", async () => {
    const current = (await ticketPage()).querySelector('.status-row > [aria-current="true"]');
    expect(current?.classList.contains("status-current")).toBe(true);
    expect(current?.text.trim()).toBe("New");
  });

  it("shares one rule with the list's selected filter", () => {
    const shared = ruleEndingWith(", .status-row > .status-current");
    expect(shared.selectors).toContain(
      ':is(nav[aria-label="Filter by status"], nav[aria-label="Filter by owner"]) a[aria-current="page"],',
    );
    expect(shared.body).toContain("border-color: var(--pd-border-strong)");
    expect(shared.body).toContain("background-color: var(--pd-subtle)");
  });
});

describe("the status row's height", () => {
  it("is one height for every item, the greyed buttons included, and 44 pixels on a phone", () => {
    const shared = ruleEndingWith(
      '.status-row > * > :is(button, summary[role="button"]), .status-row > .status-current',
    );
    expect(shared.body).toContain("min-height: 2.25rem");
    expect(shared.body).toContain("margin: 0");
    const phone = css.slice(css.indexOf("min-height: 2.25rem"));
    expect(phone).toMatch(
      /@media \(max-width: 639px\) \{\s*\.status-row > \* > :is\(button, summary\[role="button"\]\),\s*\.status-row > \.status-current \{\s*min-height: 44px;/,
    );
  });
});

describe("the resolve form", () => {
  it("holds a reason and the Resolve button, with no paragraph before them", async () => {
    const form = (await ticketPage()).querySelector("details.resolve form")!;
    expect(form.querySelector("p")).toBeNull();
    expect(form.querySelector("label")!.text.trim()).toMatch(/^Reason/);
    expect(form.querySelector("button[type=submit]")!.text.trim()).toBe("Resolve");
  });
});

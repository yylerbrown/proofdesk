import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { buildTestApp, visitor } from "./helpers.js";

// The ticket page's type and spacing, as values: three type sizes in the column (28, 16 and 13
// pixels), and spacing in three steps, 12 inside the head, 24 inside the ticket's own block and
// 32 around the conversation. The footer's links start at the centred column's left edge.

const css = fs.readFileSync("public/site.css", "utf8");

/** The declarations of the first top-level rule written exactly for this selector. */
function ruleFor(selector: string): string {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const found of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (found[1]!.trim() === selector) return found[2]!;
  }
  throw new Error(`No rule for ${selector}`);
}

describe("the ticket page's spacing", () => {
  it("is 12 inside the head: the way back to the title, and the title to its line", () => {
    const title = ruleFor(".ticket-page h1");
    expect(title).toContain("margin-top: var(--pd-space-3);");
    expect(title).toContain("margin-bottom: var(--pd-space-3);");
  });

  it("is 24 inside the step's card, with where it stands 12 over the step", () => {
    // 32 around the card, more than any space inside it, so the ticket, the step and the
    // conversation read as three groups.
    expect(ruleFor("article.ticket-card")).toContain("margin: var(--pd-space-6) 0;");
    expect(ruleFor(".ticket-card blockquote")).toContain("margin: 0;");
    expect(ruleFor(".ticket-card .card-line")).toContain("margin: var(--pd-space-5) 0 0;");
    expect(ruleFor(".ticket-card .card-step")).toContain("margin: var(--pd-space-5) 0 0;");
    expect(ruleFor(".ticket-card .card-line + .card-step")).toContain(
      "margin-top: var(--pd-space-3);",
    );
  });

  it("is 32 around the conversation, 24 under its hairline, and 12 between the last two rows", () => {
    expect(ruleFor("hr.thread-start")).toContain("margin: var(--pd-space-6) 0 var(--pd-space-5);");
    expect(ruleFor(".ticket-last-row")).toContain("margin-top: var(--pd-space-6);");
    // With no messages yet, the message box sits straight under the hairline's 24.
    expect(ruleFor("#conversation + .ticket-last-row")).toContain("margin-top: 0;");
    expect(ruleFor(".ticket-more-row")).toContain("margin-top: var(--pd-space-3);");
    expect(ruleFor(".ticket-more-row")).toContain("gap: var(--pd-space-3) var(--pd-space-5);");
  });
});

describe("the ticket page's type", () => {
  it("sets where it stands at reading size and full colour, and the small labels at 13px", () => {
    const line = ruleFor(".ticket-card .card-line");
    expect(line).toContain("color: var(--pd-text);");
    expect(line).not.toContain("font-size");
    const labels = ruleFor(".ticket-card .card-label,\n.ticket-card .card-detail");
    expect(labels).toContain("font-size: var(--pd-text-sm);");
    expect(labels).toContain("font-weight: var(--pd-weight-regular);");
    expect(ruleFor(".fact-value")).toContain("font-size: var(--pd-text-sm);");
    expect(ruleFor(".ticket-standing")).toContain("font-size: var(--pd-text-sm);");
  });

  it("sets the resolve form's question and choices at 16px, and conversation lines at 1.5", () => {
    expect(ruleFor(".step-form legend")).toContain("font-size: 1.0667rem;");
    expect(ruleFor(".step-form fieldset label")).toContain("font-size: 1.0667rem;");
    expect(ruleFor(".step-form fieldset label")).toContain("min-height: 32px;");
    expect(ruleFor(".step-form .resolve-duplicate input")).toContain("max-width: 12rem;");
    expect(ruleFor("article.entry > p")).toContain("line-height: 1.5;");
  });
});

describe("the footer under the centred column", () => {
  it("starts its links at the column's left edge", async () => {
    const rule = ruleFor("main:has(> :is(.column, .column-narrow)) + .site-footer > small");
    expect(rule).toContain("max-width: var(--pd-column);");
    expect(rule).toContain("margin-inline: auto;");
    // The rule reaches the footer only because it comes straight after the page's main.
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const html = parse((await visitor(app).get("/tickets/SUP-1/nothing-here")).text);
    const footer = html.querySelector("footer.site-footer")!;
    expect(footer.previousElementSibling?.tagName).toBe("MAIN");
  });
});

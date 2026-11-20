import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, visitor } from "./helpers.js";

// Small things a person sees: the status marks drawn as one picture each, the dot beside the
// person you are in the demo's menu, what the Proof column's marks mean, and on a phone, links
// tall enough to press and a History that reads down the screen.

const css = fs.readFileSync("public/site.css", "utf8");
const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of each rule written exactly for this selector, in the stylesheet's order. */
function rulesFor(selector: string): string[] {
  const found: string[] = [];
  for (const rule of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1]!.trim().replace(/\s+/g, " ") === selector) found.push(rule[2]!);
  }
  return found;
}

/** The phone rules: every rule inside a block for screens under 640 wide. */
function phoneRulesFor(selector: string): string[] {
  const found: string[] = [];
  for (const block of plain.matchAll(/@media \(max-width: 639px\) \{([\s\S]*?)\n\}/g)) {
    for (const rule of block[1]!.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (rule[1]!.trim().replace(/\s+/g, " ") === selector) found.push(rule[2]!);
    }
  }
  return found;
}

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asDemo = (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  return { ...built, asDemo };
}

describe("the status marks", () => {
  it("are each one picture, a ring and its fill drawn on one centre", () => {
    const files = {
      new: fs.readFileSync("public/status-new.svg", "utf8"),
      in_progress: fs.readFileSync("public/status-in-progress.svg", "utf8"),
      resolved: fs.readFileSync("public/status-resolved.svg", "utf8"),
    };
    for (const svg of Object.values(files)) {
      expect(svg).toContain('viewBox="0 0 12 12"');
      // The ring: a 1.5 line round the centre of the 12 by 12 box.
      expect(svg).toContain(
        '<circle cx="6" cy="6" r="5.25" fill="none" stroke="#000" stroke-width="1.5"/>',
      );
    }
    expect(files.new.match(/<(circle|path)/g)).toHaveLength(1);
    // In Progress: the right half of a dot of radius 3 on the same centre.
    expect(files.in_progress).toContain('<path d="M6 3 A3 3 0 0 1 6 9 Z" fill="#000"/>');
    // Resolved: the full dot.
    expect(files.resolved).toContain('<circle cx="6" cy="6" r="3" fill="#000"/>');
  });

  it("are painted in the status colour through those pictures, with no border or padding to round apart", () => {
    const mark = rulesFor(".badge::before")[0]!;
    expect(mark).toContain("width: var(--pd-badge-dot);");
    expect(mark).toContain('mask: url("/assets/status-new.svg") center / contain no-repeat;');
    expect(mark).not.toMatch(/border|padding|background-clip/);
    expect(rulesFor(".status-new::before")[0]).toContain("background-color: var(--pd-badge-new);");
    const progress = rulesFor(".status-in_progress::before")[0]!;
    expect(progress).toContain("background-color: var(--pd-badge-in_progress);");
    expect(progress).toContain('mask-image: url("/assets/status-in-progress.svg");');
    const resolved = rulesFor(".status-resolved::before")[0]!;
    expect(resolved).toContain("background-color: var(--pd-badge-resolved);");
    expect(resolved).toContain('mask-image: url("/assets/status-resolved.svg");');
    expect(css).not.toContain("conic-gradient");
    // In forced colours the fill would be dropped, so the mark is painted in the text colour.
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.badge::before \{\s*background-color: CanvasText;\s*forced-color-adjust: none;/,
    );
  });
});

describe("the demo's switch-person menu", () => {
  it("marks the person you are with the Status menu's small dot, keeping its words", async () => {
    const dot = rulesFor(".person-menu .role-current::after")[0]!;
    const statusDot = rulesFor(
      ".ticket-facts details.dropdown.fact-menu > summary + ul li > .menu-current::after",
    )[0]!;
    for (const line of [
      "width: 6px;",
      "height: 6px;",
      "margin-inline-start: auto;",
      "border-radius: 50%;",
      "background: currentColor;",
    ]) {
      expect(dot, line).toContain(line);
      expect(statusDot, line).toContain(line);
    }
    expect(rulesFor(".person-menu .role-current")[0]).toContain("display: flex;");
    const { asDemo } = demo();
    const html = parse((await asDemo("demo-team").get("/tickets")).text);
    const current = html.querySelector(".person-menu .role-current")!;
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(current.text).toBe("Demo Team Member (you)");
  });
});

describe("what the Proof column's marks mean", () => {
  it("is one quiet line under the list, with both marks drawn as in the column", async () => {
    const { asDemo } = demo();
    const html = parse((await asDemo("demo-team").get("/tickets")).text);
    const legend = html.querySelector(".proof-legend")!;
    expect(legend.text.replace(/\s+/g, " ").trim()).toBe(
      "Says what would prove it is fixed Customer confirmed",
    );
    const marks = legend.querySelectorAll(".proof-mark");
    expect(marks.map((mark) => mark.classList.toString())).toEqual([
      "proof-mark proof-said",
      "proof-mark confirmed-mark",
    ]);
    for (const mark of marks) expect(mark.getAttribute("aria-hidden")).toBe("true");
    // After the table, inside the list's area.
    expect(html.querySelector(".list-area > .proof-legend")).not.toBeNull();
    // The column's marks and the line's share one look.
    expect(rulesFor(":is(table.tickets, .proof-legend) .proof-mark")[0]).toContain("width: 16px;");
  });

  it("is not shown while no row has a mark", async () => {
    const { app } = buildTestApp();
    const { as, customerOne } = await import("./helpers.js");
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const html = parse((await as(app, customerOne).get("/tickets")).text);
    expect(html.querySelector("table.tickets")).not.toBeNull();
    expect(html.querySelector(".proof-legend")).toBeNull();
  });
});

describe("on a phone", () => {
  it("gives each small link a tap area at least 40 pixels tall, looking the same", () => {
    // 12 pixels above and below a line of about 16 to 20 pixels, taken back by the margin.
    for (const selector of [
      ".site-footer a",
      ".ticket-card :is(.card-label a.card-label-link, .card-proof-add a, .card-line a.card-line-link)",
    ]) {
      const rule = phoneRulesFor(selector)[0];
      expect(rule, selector).toBeDefined();
      expect(rule, selector).toContain("display: inline-block;");
      expect(rule, selector).toContain("margin-block: -12px;");
      expect(rule, selector).toContain("padding-block: 12px;");
    }
    // The picture's Remove is already a 40-pixel button there.
    expect(phoneRulesFor(".picture-strip button.picture-remove")[0]).toContain("min-height: 40px;");
  });

  it("stacks each History row: When and Who on one grey line, What under it at full width", () => {
    const row = phoneRulesFor("details.history tbody tr")[0]!;
    expect(row).toContain("display: grid;");
    expect(row).toMatch(/grid-template-areas:\s*"when who"\s*"what what";/);
    expect(phoneRulesFor("details.history tbody td:nth-child(1)")[0]).toContain("grid-area: when;");
    expect(phoneRulesFor("details.history tbody td:nth-child(2)")[0]).toContain("grid-area: what;");
    const who = phoneRulesFor("details.history tbody td:nth-child(3)")[0]!;
    expect(who).toContain("grid-area: who;");
    expect(who).toContain("color: var(--pd-muted);");
    // The header row is kept for a screen reader.
    expect(phoneRulesFor("details.history thead")[0]).toContain("clip-path: inset(50%);");
  });
});

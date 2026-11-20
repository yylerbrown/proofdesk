import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { afterLeadWord, paragraphs, roleAfterName } from "../src/server/pages/format.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { admin, as, buildTestApp, customerOne, teamActor, visitor } from "./helpers.js";

// The formatting faults a recrawl of every page found, each pinned by what the page sends and
// by the style rule that draws it.

const css = fs.readFileSync("public/site.css", "utf8");
const plainCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of every top-level or nested rule written exactly for this selector. */
function rulesFor(selector: string): string {
  const found = [...plainCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]!.trim() === selector)
    .map((match) => match[2]!);
  if (found.length === 0) throw new Error(`No rule for ${selector}`);
  return found.join("\n");
}

/** The style sheet's text inside the first media block with exactly this condition. */
function mediaBlock(condition: string): string {
  const start = css.indexOf(`@media ${condition} {`);
  if (start < 0) throw new Error(`No media block ${condition}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`Unclosed media block ${condition}`);
}

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  const asDemo = (id: string) => visitor(built.app).set("Cookie", `${DEV_COOKIE}=${id}`);
  return { ...built, asDemo };
}

async function demoPage(id: string, address: string) {
  const res = await demo().asDemo(id).get(address);
  expect(res.status).toBe(200);
  return parse(res.text);
}

describe("the confirmed mark on a ticket page", () => {
  it("is the list's green circle with its check, at a status mark's size", () => {
    const tick = rulesFor(".ticket-page .tick");
    expect(tick).toContain('url("/assets/proof-confirmed.svg")');
    expect(tick).toContain("width: var(--pd-badge-dot);");
    expect(tick).toContain("height: var(--pd-badge-dot);");
    expect(tick).toContain("background-color: var(--pd-status-resolved);");
  });
});

describe("a card that holds only its standing sentence", () => {
  it("starts the sentence at the card's padding, and keeps a link on the sentence's line", () => {
    expect(rulesFor(".ticket-card > .card-line:first-child")).toContain("margin-top: 0;");
    // Running text, so "Open SUP-5" follows the sentence's last word when it fits.
    expect(rulesFor(".ticket-card .card-line")).not.toContain("display: flex");
  });
});

describe("the assistant's card", () => {
  it("has no line above it when it opens the step's card, and the step card's padding", () => {
    const first = rulesFor(".ticket-card > .assistant-card:first-child");
    expect(first).toContain("border-top: 0;");
    expect(first).toContain("padding-top: 0;");
    expect(rulesFor(".assistant-card")).toContain("padding: var(--pd-space-4) var(--pd-space-5);");
    expect(rulesFor("article.ticket-card")).toContain(
      "padding: var(--pd-space-4) var(--pd-space-5);",
    );
  });

  it("draws the evidence's body text in one size and lines up its lists' values", () => {
    expect(rulesFor("ul.evidence p:first-child")).toContain("font-size: var(--pd-text-sm);");
    expect(rulesFor("dl.evidence-fields")).toContain(
      "grid-template-columns: minmax(7.5rem, max-content) minmax(0, 1fr);",
    );
    expect(rulesFor("dl.evidence-fields dt")).not.toContain("font-size");
  });

  it("reads each scenario line as one sentence, without a capital after Given or Then", async () => {
    const page = await demoPage("demo-team", "/tickets/SUP-4");
    const lines = page.querySelectorAll("ol.scenarios li p.user-text").map((p) => p.text);
    expect(lines).toContain("Given a price of 100 and a tax rate of 0.1");
    expect(lines).toContain("Then it returns 110");
  });

  it("keeps a wrapped byline's dot with its day", async () => {
    const page = await demoPage("demo-team", "/tickets/SUP-4");
    const header = page.querySelector("article.entry.note header")!;
    expect(header.querySelector(".byline-when")!.text.trim()).toMatch(/^· /);
    expect(header.querySelector("small")!.text.trim()).not.toMatch(/·$/);
    expect(rulesFor(".entry .byline-when")).toContain("white-space: nowrap;");
  });
});

describe("the words after Given, When and Then", () => {
  it("start in lower case only for an ordinary capitalised first word", () => {
    expect(afterLeadWord("A price of 100")).toBe("a price of 100");
    expect(afterLeadWord("It returns 110")).toBe("it returns 110");
    expect(afterLeadWord("total(100, 0.1) is called")).toBe("total(100, 0.1) is called");
    expect(afterLeadWord("I sign in")).toBe("I sign in");
    expect(afterLeadWord("API returns 200")).toBe("API returns 200");
  });
});

describe("the bulk bar", () => {
  it("has selects and Apply of one height, and on a phone only the height it needs", () => {
    expect(rulesFor(".bulk-bar :is(select, button)")).toContain("height: 34px;");
    expect(rulesFor(".bulk-dock .bulk-bar")).toContain("min-height: var(--bulk-row-height, 0px);");
    // That height is only kept where the filters are one short row.
    expect(css).toMatch(
      /@media \(min-width: 640px\) \{\s*\.bulk-dock \.bulk-bar \{\s*min-height: var\(--bulk-row-height, 0px\);/,
    );
    expect(plainCss).not.toMatch(/\.bulk-dock \.bulk-bar \{[^}]*padding-block: 2px/);
  });
});

describe("About this demo's sample batch", () => {
  it("names the action as its button does, with its labels beside their boxes", async () => {
    const page = await demoPage("demo-customer", "/sign-in");
    expect(page.querySelector("form.sample-batch > p")!.text).toBe(
      "Want a fuller list to filter, sort and search? Add sample tickets.",
    );
    expect(rulesFor(".about-demo .sample-batch label")).toContain("display: inline-flex;");
    expect(rulesFor(".about-demo .sample-batch :is(select, button)")).toContain("height: 34px;");
    expect(rulesFor(".welcome a.keep-together")).toContain("white-space: nowrap;");
  });
});

describe("the owner under the title", () => {
  it("sits where the menu would when it cannot be changed", () => {
    const fact = rulesFor(".ticket-facts .fact");
    expect(fact).not.toContain("padding-inline: 0");
    expect(fact).toContain("max-width: 100%;");
  });
});

describe("History and More options", () => {
  it("stack at every width, so each opens under its own line", () => {
    expect(rulesFor(".ticket-more-row")).not.toContain("display: flex");
    expect(plainCss).not.toContain(".ticket-more-row > details[open] {\n  display: contents;");
    expect(
      rulesFor("ul.more-list > li > a,\nul.more-list button.link,\nul.more-list details > summary"),
    ).toContain("text-decoration: underline;");
  });
});

describe("the possible-duplicate and similar-ticket lines", () => {
  it("puts the press that closes it as a duplicate on a line of its own", () => {
    expect(rulesFor(".possible-duplicate p")).not.toContain("display: flex");
    expect(rulesFor(".possible-duplicate button.link")).toContain("display: block;");
  });
});

describe("the description", () => {
  it("is split into paragraphs at blank lines", () => {
    expect(paragraphs("One.\n\nTwo.")).toEqual(["One.", "Two."]);
    expect(paragraphs("One.\r\n\r\n\r\nTwo.\nStill two.")).toEqual(["One.", "Two.\nStill two."]);
    expect(paragraphs("  ")).toEqual([""]);
  });

  it("draws each paragraph as its own, one gap apart, with a picture the same gap under", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams.\n\n\nOn page two." });
    const page = parse((await as(app, customerOne).get("/tickets/SUP-1")).text);
    const description = page.querySelector(".ticket-description")!;
    expect(description.querySelectorAll("p").map((p) => p.text)).toEqual([
      "It jams.",
      "On page two.",
    ]);
    expect(
      rulesFor(
        ".ticket-description > p + p,\n.ticket-page .ticket-description + :is(.pictures, p.picture-hidden)",
      ),
    ).toContain("margin-top: var(--pd-space-4);");
  });
});

describe("the resolve form", () => {
  it("puts every label above its box, and starts its placeholder with a capital", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams." });
    await admin(app).post("/api/tickets/SUP-1/take");
    const page = parse((await admin(app).get("/tickets/SUP-1?step=resolve")).text);
    expect(page.querySelector("input[name=fixed_in]")!.getAttribute("placeholder")).toBe(
      "A version, or live now",
    );
    expect(
      rulesFor(
        ".step-form label:is(.resolve-duplicate, .resolve-fixed-in, .resolve-note) > :is(input, textarea)",
      ),
    ).toContain("display: block;");
  });
});

describe("the emails page and the edit form", () => {
  it("carry the ticket pages' way back, one step further", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "It jams." });
    const team = parse((await as(app, teamActor).get("/tickets/SUP-1/edit")).text);
    expect(team.querySelector("p.back")!.text).toBe("All tickets / SUP-1 / Edit");
    const customer = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(customer.querySelector("p.back")!.text).toBe("My tickets / SUP-1 / Edit");
    expect(rulesFor("article.email .email-state")).toContain("border-radius: var(--pd-radius);");
  });
});

describe("the ticket list between 1100 and 1250 wide", () => {
  it("puts a status tag under its word and keeps the search box at the left", () => {
    const narrow = mediaBlock("(min-width: 640px) and (max-width: 1249px)");
    expect(narrow).toContain("display: block;");
    expect(mediaBlock("(min-width: 1100px) and (max-width: 1249px)")).toContain("width: 12rem;");
    expect(rulesFor("form.list-search")).toContain("margin: 0;");
    expect(rulesFor("form.list-search")).not.toContain("auto");
  });
});

describe("the recorded run's page", () => {
  it("uses the centred column, and its fold's mark sits beside its label", async () => {
    const page = await demoPage("demo-customer", "/assistant-run");
    expect(page.querySelector(".assistant-run")!.classList.contains("column")).toBe(true);
    expect(page.querySelector("h3")!.text).toBe("Setup steps before the run");
    // One rule draws every fold-open line's chevron right after its words.
    expect(plainCss).toContain("details:not(.dropdown) > summary:where(:not([role]))::after {");
  });
});

describe("bylines", () => {
  it("leave out, on the demo only, a role word the name already ends with", () => {
    expect(roleAfterName("Demo Customer", "customer", true)).toBeNull();
    expect(roleAfterName("Demo Team Member", "team", true)).toBeNull();
    expect(roleAfterName("Sam", "customer", true)).toBe("Customer");
    expect(roleAfterName("Sam", null, true)).toBeNull();
    // A name a person chose never hides their role.
    expect(roleAfterName("Bo Team", "team", false)).toBe("Team member");
  });

  it("read 'Demo Customer · day' in messages and in History's Who", async () => {
    const page = await demoPage("demo-team", "/tickets/SUP-3");
    const customer = page
      .querySelectorAll("article.entry header")
      .find((header) => header.querySelector("strong")!.text === "Demo Customer")!;
    expect(customer.querySelector("small")!.text.trim()).toMatch(/^· /);
    const who = page
      .querySelectorAll("details.history tbody td:last-child")
      .filter((cell) => cell.text.includes("Demo Customer"));
    expect(who.length).toBeGreaterThan(0);
    for (const cell of who) expect(cell.querySelector(".role-label")).toBeNull();
  });
});

describe("the welcome card on a phone", () => {
  it("gives each quiet press a 40-pixel row, evenly spaced", () => {
    expect(css).toMatch(
      /\.demo-welcome-more \{\s*flex-direction: column;\s*align-items: flex-start;\s*gap: 0;/,
    );
    expect(css).toMatch(
      /\.demo-welcome-more button\.link \{\s*display: flex;\s*align-items: center;\s*min-height: 40px;/,
    );
  });
});

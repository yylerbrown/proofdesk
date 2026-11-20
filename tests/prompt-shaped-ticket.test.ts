import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, customerOne, resolveTicket, teamActor, visitor } from "./helpers.js";

// A ticket is shaped like a good prompt: the problem (the title), the context (the description)
// and what would prove it is fixed (the customer's check). The forms ask for the first two, each
// with one grey hint; the third is the step after filing, with its own grey hint. The ticket page
// and the history use the same name for the third part, the list marks the tickets that have it,
// and the pages that say what Proofdesk is say it in these words.

const SENTENCE =
  "Proofdesk is a support desk where a ticket is shaped like a good prompt: the problem, the " +
  "context, and what would prove it is fixed.";

const withCheck = { title: "Printer jams", description: "It jams.", fix_check: "Ten pages print" };
const withoutCheck = { title: "Fax is slow", description: "It takes an hour." };

type Page = ReturnType<typeof parse>;

/** The label words and the hint under them, for each box of a ticket form, in order. */
function boxes(html: Page) {
  return ["title", "description"].map((name) => ({
    label: html.querySelector(`#${name}-label`)?.text,
    hint: html.querySelector(`#${name}-hint`)?.text,
  }));
}

const SHAPE = [
  { label: "Title", hint: "The problem, in a few words." },
  { label: "Description", hint: "The context: what you were doing, and what happened." },
];

describe("the ticket forms", () => {
  it("name the problem and the context, one hint per box", async () => {
    const { app } = buildTestApp();
    const html = parse((await as(app, customerOne).get("/tickets/new").redirects(1)).text);
    expect(boxes(html)).toEqual(SHAPE);
    // Each hint is read as its box's description, never as part of its name.
    expect(html.querySelector("[name=title]")?.getAttribute("aria-describedby")).toBe("title-hint");
  });

  it("leave what would prove it is fixed to the step after filing, with its own hint", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withoutCheck);
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1?step=verify")).text);
    const step = html.querySelector("form#verify-form")!;
    expect(step.querySelector("label")?.text).toBe("What would prove it is fixed?");
    expect(step.querySelector("#proof-hint")?.text).toBe(
      "One thing you can check yourself when the team says it is fixed. Tickets that say what would prove it is fixed are listed first for the team.",
    );
  });

  it("are the same on the customer's edit form", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withCheck);
    const html = parse((await as(app, customerOne).get("/tickets/SUP-1/edit")).text);
    expect(boxes(html)).toEqual(SHAPE);
  });
});

describe("the ticket page", () => {
  it("labels the customer's check with what would prove it is fixed", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withCheck);
    for (const who of [customerOne, teamActor]) {
      const html = parse((await as(app, who).get("/tickets/SUP-1")).text);
      // The label's own words; its filer also has a quiet Change beside them.
      expect(html.querySelector(".ticket-card .card-label")?.childNodes[0]?.text.trim()).toBe(
        "What would prove it is fixed?",
      );
    }
  });

  it("says the same name in the history when the check is edited", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withoutCheck);
    const { version } = (await as(app, customerOne).get("/api/tickets/SUP-1")).body;
    const edited = await as(app, customerOne)
      .put("/api/tickets/SUP-1")
      .send({ ...withoutCheck, fix_check: "It takes a minute", expected_version: version });
    expect(edited.status).toBe(200);
    const history = parse((await as(app, customerOne).get("/tickets/SUP-1")).text)
      .querySelector("details.history")!
      .text.replace(/\s+/g, " ");
    expect(history).toContain("Edited: what would prove it is fixed");
  });
});

describe("the list's Proof column", () => {
  /** Each row's key, and the name of the mark in its Proof cell, or "" when it is blank. */
  async function proofMarks(app: Parameters<typeof as>[0], who: typeof teamActor) {
    const html = parse((await as(app, who).get("/tickets?status=all")).text);
    const headers = html.querySelectorAll("table.tickets thead th");
    const at = headers.findIndex((th) => th.text.trim() === "Proof");
    // Directly after Status, and it sorts nothing.
    expect(headers[at - 1]?.querySelector(".sort-label")?.text).toBe("Status");
    expect(headers[at]?.querySelector("a")).toBeNull();
    const marks: Record<string, string> = {};
    for (const row of html.querySelectorAll("table.tickets tbody tr")) {
      const cells = row.querySelectorAll("td");
      const mark = cells[at]!.querySelector("[role=img]");
      expect(mark?.getAttribute("title") ?? "").toBe(mark?.getAttribute("aria-label") ?? "");
      marks[cells[0]!.text.trim()] = mark?.getAttribute("aria-label") ?? "";
    }
    return marks;
  }

  it("is blank without a check, outlined with one, and solid once the customer confirmed", async () => {
    const { app } = buildTestApp();
    await as(app, customerOne).post("/api/tickets").send(withoutCheck);
    await as(app, customerOne).post("/api/tickets").send(withCheck);
    await as(app, customerOne).post("/api/tickets").send(withCheck);
    await resolveTicket(app, "SUP-3", customerOne);
    for (const who of [customerOne, teamActor]) {
      expect(await proofMarks(app, who)).toEqual({
        "SUP-1": "",
        "SUP-2": "Says what would prove it",
        "SUP-3": "Customer confirmed",
      });
    }
  });

  it("draws the two marks the same size, and only the confirmed one filled", async () => {
    const said = fs.readFileSync("public/proof-said.svg", "utf8");
    const confirmed = fs.readFileSync("public/proof-confirmed.svg", "utf8");
    const viewBox = (svg: string) => /viewBox="([^"]+)"/.exec(svg)?.[1];
    expect(viewBox(said)).toBe(viewBox(confirmed));
    expect(said).toMatch(/<circle [^>]*fill="none"/);
    expect(confirmed).toMatch(/<circle [^>]*fill="#000"/);
    // The style sheet draws each mark through its own file, at one size for both.
    const css = fs.readFileSync("public/site.css", "utf8");
    expect(css).toContain('mask: url("/assets/proof-said.svg")');
    expect(css).toContain('mask-image: url("/assets/proof-confirmed.svg")');
  });
});

describe("the sentence that says what Proofdesk is", () => {
  it("opens the demo's welcome card and its About page", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const list = parse((await visitor(app).get("/tickets")).text);
    expect(list.querySelector("#demo-welcome-text")?.text).toBe(
      `${SENTENCE} You are trying it as a customer.`,
    );
    const about = parse((await visitor(app).get("/sign-in")).text);
    expect(about.querySelector("hgroup p")?.text).toBe(SENTENCE);
  });
});

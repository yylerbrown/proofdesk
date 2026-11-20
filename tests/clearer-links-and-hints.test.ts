import fs from "node:fs";
import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { seedDemo } from "../src/server/demo.js";
import { createTicketService } from "../src/server/tickets/service.js";
import { buildTestApp, FROM_THIS_SITE, visitor } from "./helpers.js";

// Small things a walk of the demo found unclear, each fixed in words or looks only: About this
// demo links the recorded assistant run, "Edit" and "Change" name what each changes, the
// sample's grey note sits above the button, the closed fold lines read stronger, the closed
// message box shows a chevron, and the proof box grows with its words.

const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector is exactly this one. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
}

function demo() {
  const built = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
  seedDemo(createTicketService(built.db, built.config.ticketPrefix));
  return built;
}

const asDemo = (app: Express, id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);

/** Files the welcome card's sample as the demo customer, then takes it as the demo team. */
async function sampleInProgress(app: Express): Promise<string> {
  const form = parse(
    (await asDemo(app, "demo-customer").get("/tickets/new?try=1").redirects(1)).text,
  );
  const filed = await asDemo(app, "demo-customer")
    .post("/tickets")
    .set(FROM_THIS_SITE)
    .type("form")
    .send({
      title: form.querySelector("input[name=title]")?.getAttribute("value") ?? "",
      description: form.querySelector("textarea[name=description]")?.text ?? "",
      where_url: "",
      fix_check: "The export has every row.",
    });
  const key = /\/tickets\/([A-Z]+-\d+)/.exec(filed.headers.location!)![1]!;
  await asDemo(app, "demo-team")
    .post(`/tickets/${key}/take-and-start`)
    .set(FROM_THIS_SITE)
    .type("form")
    .send({});
  return key;
}

describe("About this demo", () => {
  it("links the recorded assistant run in one plain sentence, signed in or out", async () => {
    const { app } = demo();
    for (const page of [
      parse((await visitor(app).get("/sign-in")).text),
      parse((await asDemo(app, "demo-customer").get("/sign-in")).text),
    ]) {
      const links = page.querySelectorAll("main a[href='/assistant-run']");
      expect(links).toHaveLength(1);
      expect(links[0]!.parentNode!.text).toBe(
        "See a ticket an AI assistant worked, and how that run was done.",
      );
    }
  });
});

describe("the ticket page's two quiet links", () => {
  it("name what each one changes, while showing Edit and Change", async () => {
    const { app } = demo();
    const key = await sampleInProgress(app);
    for (const id of ["demo-team", "demo-customer"]) {
      const page = parse((await asDemo(app, id).get(`/tickets/${key}`)).text);
      const edit = page.querySelector(`a[href='/tickets/${key}/edit']`)!;
      expect(edit.text, id).toBe("Edit");
      expect(edit.getAttribute("aria-label"), id).toBe("Edit title or description");
      expect(edit.getAttribute("title"), id).toBe("Edit title or description");
    }
    const view = fs.readFileSync("views/ticket-show.ejs", "utf8");
    expect(view).toContain(
      'aria-label="Change what would prove it is fixed" title="Change what would prove it is fixed">Change</a>',
    );
  });
});

describe("the sample's note on the team's In Progress step", () => {
  it("sits on its own line after the agreement line and above the button", async () => {
    const { app } = demo();
    const key = await sampleInProgress(app);
    const page = parse((await asDemo(app, "demo-team").get(`/tickets/${key}`)).text);
    const parts = page
      .querySelectorAll(".next-action > *")
      .map((part) => part.classNames || part.tagName);
    expect(parts).toEqual(["next-oath", "next-note", "FORM"]);
    expect(page.querySelector(".next-action p.next-note")?.text).toBe("The sample skips the fix.");
    expect(rule(".next-oath,\n.next-note")).toContain("flex-basis: 100%");
  });
});

describe("the fold-open lines", () => {
  it("read a step darker than muted, with a full-strength chevron and an underline on hover", () => {
    const line = rule("details:not(.dropdown) > summary:where(:not([role]))");
    expect(line).toContain("cursor: pointer");
    expect(line).toMatch(/color: color-mix\(in srgb, var\(--pd-muted\) \d+%, var\(--pd-text\)\)/);
    expect(rule("details:not(.dropdown) > summary:where(:not([role]))::after")).not.toContain(
      "opacity",
    );
    expect(rule("details:not(.dropdown) > summary:where(:not([role])):hover")).toContain(
      "text-decoration: underline",
    );
  });

  it("include the closed message box, which shows a pointer and the chevron after its words", () => {
    expect(rule("details.reply-fold:not([open]) > summary")).toContain("cursor: pointer");
    expect(rule("details.reply-fold:not([open]) > summary::after")).not.toContain("display: none");
  });
});

describe("the proof box", () => {
  it("grows with its words from three lines to about ten, by stylesheet or by script", () => {
    const box = rule(".proof-step textarea");
    expect(box).toContain("field-sizing: content");
    expect(box).toMatch(/min-height: calc\(\s*3lh/);
    expect(box).toMatch(/max-height: calc\(\s*10lh/);
    const script = fs.readFileSync("src/browser/proof-step.ts", "utf8");
    expect(script).toContain('if (!CSS.supports("field-sizing", "content"))');
  });
});

import fs from "node:fs";
import { parse } from "node-html-parser";
import type { Express } from "express";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { as, buildTestApp, customerOne, FROM_THIS_SITE, teamActor, visitor } from "./helpers.js";

// Small things two outside walks of the demo doubted, each fixed without adding a control: the
// sort headers look pressable, a long title gets one more line on a mid-width window, the
// sample button says it commits to nothing, the footer names the source, and the guided sample
// says it has no real fix to make.

const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const asDemo = (app: Express, id: string) => visitor(app).set("Cookie", `${DEV_COOKIE}=${id}`);

/** The words of the sample the welcome card files, as the form fills them in. */
async function sampleValues(app: Express) {
  const form = parse(
    (await asDemo(app, "demo-customer").get("/tickets/new?try=1").redirects(1)).text,
  );
  return {
    title: form.querySelector("input[name=title]")?.getAttribute("value") ?? "",
    description: form.querySelector("textarea[name=description]")?.text ?? "",
  };
}

/** Files a ticket as the demo customer, takes it as the demo team, and returns the ask's note. */
async function askNote(app: Express, ticket: { title: string; description: string }) {
  const filed = await asDemo(app, "demo-customer")
    .post("/tickets")
    .set(FROM_THIS_SITE)
    .type("form")
    .send({ ...ticket, where_url: "", fix_check: "" });
  const key = /\/tickets\/([A-Z]+-\d+)/.exec(filed.headers.location!)![1]!;
  await asDemo(app, "demo-team")
    .post(`/tickets/${key}/take-and-start`)
    .set(FROM_THIS_SITE)
    .type("form")
    .send({});
  const page = parse((await asDemo(app, "demo-team").get(`/tickets/${key}`)).text);
  return page.querySelector(".next-action .next-note")?.text;
}

describe("the list's sort headers", () => {
  it("show a faint two-way mark before any is pressed, hidden from screen readers", async () => {
    expect(css).toMatch(
      /table\.tickets thead \.sort-arrow:empty::after \{[^}]*content: "\\2195" \/ "";[^}]*opacity/,
    );
    const { app } = buildTestApp();
    await as(app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "x" });
    const list = parse((await as(app, teamActor).get("/tickets")).text);
    const arrows = list.querySelectorAll("table.tickets thead .sort-arrow");
    expect(arrows.length).toBeGreaterThan(0);
    for (const arrow of arrows) expect(arrow.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a long title in the list", () => {
  it("gets three lines below 1100px wide, and two above", () => {
    expect(css).toMatch(
      /@media \(min-width: 640px\) and \(max-width: 1099px\) \{\s*table\.tickets td\.user-text a \{[^}]*line-clamp: 3;/,
    );
  });
});

describe("the demo", () => {
  it("says the sample button fills in a ticket the visitor can still change", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const html = parse((await visitor(app).get("/tickets")).text);
    const button = html.querySelector(".demo-welcome a[href='/tickets/new?try=1']")!;
    const id = button.getAttribute("aria-describedby")!;
    expect(html.getElementById(id)?.text).toBe("Prefilled and editable");
  });

  it("links to the source beside About this demo in the footer", async () => {
    const { app } = buildTestApp({
      DEMO: "on",
      DEV_SIGN_IN: "off",
      SOURCE_URL: "https://example.com/source",
    });
    const footer = parse((await visitor(app).get("/tickets")).text).querySelector("footer")!;
    expect(footer.querySelectorAll("a").map((a) => [a.text, a.getAttribute("href")])).toEqual([
      ["About this demo", "/sign-in"],
      ["Source", "https://example.com/source"],
    ]);
  });

  it("says beside Ask the customer to verify that the sample skips the fix, on the sample only", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const sample = await sampleValues(app);
    expect(await askNote(app, sample)).toBe(
      'Sends the customer "Did this fix it?". The sample skips the fix.',
    );
    expect(await askNote(app, { ...sample, description: "Something I typed myself." })).toBe(
      'Sends the customer "Did this fix it?".',
    );
  });
});

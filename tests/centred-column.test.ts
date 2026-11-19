import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { DEV_COOKIE } from "../src/server/actor.js";
import { adminActor, as, buildTestApp, customerOne, visitor } from "./helpers.js";
import { ok } from "./notify-life.js";

// Pages with one job sit in one centred column of reading width, with the page title at its
// left edge. The ticket list and People keep the full width.

const css = fs.readFileSync("public/site.css", "utf8");

/** The class of the element that holds the page's title, as a direct child of main. */
function titleColumn(html: string): string | null {
  let holder = parse(html).querySelector("main h1");
  while (holder && holder.parentNode?.tagName !== "MAIN") holder = holder.parentNode;
  return holder?.getAttribute("class") ?? null;
}

async function withTicket() {
  const built = buildTestApp();
  await ok(
    as(built.app, customerOne)
      .post("/api/tickets")
      .send({ title: "Printer jams", description: "On page two." }),
    201,
  );
  return built;
}

describe("the one centred column", () => {
  it("is one width token, used by a column centred under the header", () => {
    expect(css.match(/--pd-column:/g)).toHaveLength(1);
    expect(css).toMatch(/:root \{\s*--pd-column: \d+px;\s*\}/);
    expect(css).toMatch(
      /\.column,\s*\.column-narrow \{\s*max-width: var\(--pd-column\);\s*margin-inline: auto;/,
    );
  });

  it("holds the title of every page with one job", async () => {
    const { app } = await withTicket();
    const pages: [string, string][] = [
      ["/tickets/new", "column ticket-form"],
      ["/tickets/SUP-1/edit", "column ticket-form"],
      ["/account", "column account"],
      ["/tickets/SUP-1/notices", "column notices"],
      ["/tickets/SUP-1/archive", "column"],
      ["/tickets/SUP-1/delete", "column"],
    ];
    for (const [path, column] of pages) {
      const res = await ok(as(app, adminActor).get(path).redirects(1));
      expect(titleColumn(res.text), path).toBe(column);
    }
    const missing = await as(app, adminActor).get("/tickets/SUP-999");
    expect(missing.status).toBe(404);
    expect(titleColumn(missing.text)).toBe("column");
  });

  it("holds About this demo too, in the same width", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const res = await visitor(app).set("Cookie", `${DEV_COOKIE}=demo-customer`).get("/sign-in");
    expect(titleColumn(res.text)).toBe("welcome");
    expect(css).toMatch(/\.welcome \{\s*max-width: var\(--pd-column\);/);
  });

  it("leaves the ticket list and People at the full width", async () => {
    const { app } = await withTicket();
    const list = await ok(as(app, adminActor).get("/tickets"));
    expect(titleColumn(list.text)).toBeNull();
    const people = await ok(as(app, adminActor).get("/people"));
    expect(titleColumn(people.text)).toBe("column-wide");
  });
});

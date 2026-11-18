import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { pressSpace, type KeyPress } from "../src/browser/button-links.js";
import { DEMO_ACTORS, DEV_COOKIE } from "../src/server/actor.js";
import { admin, buildTestApp, visitor } from "./helpers.js";

// Keyboard and screen-reader basics shared by every page: a skip link as the first stop, the
// demo strip inside the header landmark, Space on links that act as buttons, a focus ring the
// filter row does not cut off, and times that never break inside themselves.

describe("the skip link", () => {
  it("is the first thing in the page and lands on the main part", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    const first = html.querySelector("body")?.childNodes.find((node) => node.nodeType === 1);
    expect(first?.toString()).toBe('<a href="#main" class="skip-link">Skip to main content</a>');
    const main = html.querySelector("main#main");
    expect(main?.getAttribute("tabindex")).toBe("-1");
  });
});

describe("the demo strip", () => {
  it("sits inside the header, so every part of the page is in a landmark", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const demoTeam = DEMO_ACTORS[1]!;
    const res = await visitor(app).get("/tickets").set("Cookie", `${DEV_COOKIE}=${demoTeam.id}`);
    expect(res.status).toBe(200);
    const html = parse(res.text);
    expect(html.querySelector("header.site-header > p.demo-strip")).not.toBeNull();
    expect(html.querySelectorAll("body > p.demo-strip")).toHaveLength(0);
  });
});

describe("Space on a link that acts as a button", () => {
  function press(key: string, target: unknown, repeat = false) {
    let prevented = false;
    const event: KeyPress = { key, repeat, target, preventDefault: () => (prevented = true) };
    const handled = pressSpace(event);
    return { handled, prevented };
  }

  function link(role: string | null) {
    let clicks = 0;
    const element = {
      tagName: "A",
      getAttribute: (name: string) => (name === "role" ? role : null),
      click: () => (clicks += 1),
    };
    return { element, clicks: () => clicks };
  }

  it("follows the link once and keeps the page from scrolling", () => {
    const button = link("button");
    expect(press(" ", button.element)).toEqual({ handled: true, prevented: true });
    expect(button.clicks()).toBe(1);
    press(" ", button.element, true);
    expect(button.clicks()).toBe(1);
  });

  it("leaves ordinary links, other elements and other keys alone", () => {
    const plain = link(null);
    expect(press(" ", plain.element)).toEqual({ handled: false, prevented: false });
    const button = link("button");
    expect(press("Enter", button.element).handled).toBe(false);
    expect(press(" ", { ...button.element, tagName: "BUTTON" }).handled).toBe(false);
    expect(press(" ", null).handled).toBe(false);
    expect(plain.clicks() + button.clicks()).toBe(0);
  });

  it("is loaded on every page", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    const scripts = html.querySelectorAll("script").map((s) => s.getAttribute("src"));
    expect(scripts).toContain("/assets/js/button-links.js");
  });
});

describe("the look", () => {
  const css = fs.readFileSync("public/site.css", "utf8");

  it("hides the skip link until it has focus", () => {
    expect(css).toMatch(/\.skip-link \{[^}]*transform: translateY\(/);
    expect(css).toMatch(/\.skip-link:focus \{\s*transform: none;\s*\}/);
  });

  it("gives the filter row room for the focus ring inside its scrolling box", () => {
    expect(css).toMatch(
      /nav\[aria-label="Filter by owner"\]\) \{\s*display: block;[^}]*margin: -4px;\s*padding: 4px;\s*overflow-x: auto;/,
    );
  });

  it("never breaks a time inside itself", () => {
    expect(css).toMatch(/\ntime \{\s*white-space: nowrap;\s*\}/);
  });
});

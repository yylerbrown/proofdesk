import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { wireMenu, type Menu, type Page } from "../src/browser/menus.js";
import { admin, buildTestApp } from "./helpers.js";

// "Switch role" and "More" are native details menus. The menus script closes them on Escape,
// with focus back on their button, and when focus or a click goes somewhere else on the page.
// Text fields show the same focus ring as buttons and links.

/** A stand-in details element: its open flag, what it holds, and the listeners it was given. */
function fakeMenu(inside: unknown[]) {
  const listeners: Record<string, (event: never) => void> = {};
  const menu = {
    open: true,
    contains: (other: unknown) => inside.includes(other),
    addEventListener: (type: string, listener: (event: never) => void) => {
      listeners[type] = listener;
    },
  };
  return { menu, listeners };
}

/** A stand-in page that keeps its click listener. */
function fakePage() {
  let listener: (event: { target: unknown }) => void = () => undefined;
  return {
    addEventListener: (_type: "click", given: typeof listener) => (listener = given),
    click: (event: { target: unknown }) => listener(event),
  };
}

function wired(inside: unknown[]) {
  const { menu, listeners } = fakeMenu(inside);
  const page = fakePage();
  let focused = 0;
  wireMenu(menu as unknown as Menu, { focus: () => (focused += 1) }, page as unknown as Page);
  const send = (type: string, event: object) => listeners[type]!(event as never);
  return { menu, page, send, focused: () => focused };
}

describe("the menus script", () => {
  it("closes an open menu on Escape and puts focus back on its button", () => {
    const { menu, send, focused } = wired([]);
    send("keydown", { key: "Escape" });
    expect(menu.open).toBe(false);
    expect(focused()).toBe(1);
  });

  it("leaves the menu alone for other keys, and leaves focus alone when it is shut", () => {
    const { menu, send, focused } = wired([]);
    send("keydown", { key: "Tab" });
    expect(menu.open).toBe(true);
    menu.open = false;
    send("keydown", { key: "Escape" });
    expect(focused()).toBe(0);
  });

  it("closes when focus moves to something outside the menu, not to one of its own choices", () => {
    const choice = {};
    const { menu, send } = wired([choice]);
    send("focusout", { relatedTarget: choice });
    expect(menu.open).toBe(true);
    send("focusout", { relatedTarget: null });
    expect(menu.open).toBe(true);
    send("focusout", { relatedTarget: {} });
    expect(menu.open).toBe(false);
  });

  it("closes on a click outside the menu, not on a click inside it", () => {
    const choice = {};
    const { menu, page } = wired([choice]);
    page.click({ target: choice });
    expect(menu.open).toBe(true);
    page.click({ target: {} });
    expect(menu.open).toBe(false);
  });

  it("is loaded on every page, as a script file the security policy allows", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    const scripts = html.querySelectorAll("script").map((s) => s.getAttribute("src"));
    expect(scripts).toContain("/assets/js/menus.js");
  });
});

describe("the menus' look", () => {
  const css = fs.readFileSync("public/site.css", "utf8");

  it("keeps the 2px focus ring on text fields, those with an error included", () => {
    const fieldFocus = css.match(/textarea:focus-visible \{[^}]*\}/g) ?? [];
    expect(fieldFocus.length).toBeGreaterThan(0);
    for (const rule of fieldFocus) expect(rule).not.toMatch(/outline: none/);
    expect(css).not.toMatch(/\[aria-invalid="true"\][^{]*:focus[^{]*\{[^}]*outline: none/);
  });

  it("measures the Switch role list against a box as wide as its button", () => {
    expect(css).toMatch(
      /\.site-header details\.dropdown\.switch-role \{\s*display: inline-block;\s*\}/,
    );
  });
});

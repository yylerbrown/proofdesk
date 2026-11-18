import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { focusLanding, type Focusable, type Landing } from "../src/browser/landing.js";
import { admin, buildTestApp } from "./helpers.js";

// Where focus starts when a page opens just after an action: on the saved or refused line at the
// top, so a screen reader reads it, or back in the search box after a search. An address with a
// part of the page in it, or a box the page already focused, keeps its focus.

/** A stand-in element that records the attributes set on it and how it was focused. */
function fakeElement() {
  const attributes: Record<string, string> = {};
  const focusCalls: { preventScroll: boolean }[] = [];
  const element: Focusable = {
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    focus: (options) => {
      focusCalls.push(options);
    },
  };
  return { element, attributes, focusCalls };
}

function landing(parts: Partial<Landing>): Landing {
  return { hash: "", focusTaken: false, message: null, searchBox: null, ...parts };
}

describe("the landing script", () => {
  it("focuses the saved line without scrolling, and keeps it out of the Tab order", () => {
    const message = fakeElement();
    expect(focusLanding(landing({ message: message.element }))).toBe(message.element);
    expect(message.attributes.tabindex).toBe("-1");
    expect(message.focusCalls).toEqual([{ preventScroll: true }]);
  });

  it("prefers the saved line to the search box", () => {
    const message = fakeElement();
    const search = fakeElement();
    focusLanding(landing({ message: message.element, searchBox: search.element }));
    expect(message.focusCalls.length).toBe(1);
    expect(search.focusCalls.length).toBe(0);
  });

  it("puts focus back in the search box after a search", () => {
    const search = fakeElement();
    expect(focusLanding(landing({ searchBox: search.element }))).toBe(search.element);
    expect(search.focusCalls).toEqual([{ preventScroll: true }]);
  });

  it("leaves focus alone when the address names a part of the page", () => {
    const message = fakeElement();
    expect(focusLanding(landing({ hash: "#conversation", message: message.element }))).toBeNull();
    expect(message.focusCalls.length).toBe(0);
    expect(message.attributes.tabindex).toBeUndefined();
  });

  it("leaves focus alone when the page has already focused a box to fix", () => {
    const message = fakeElement();
    expect(focusLanding(landing({ focusTaken: true, message: message.element }))).toBeNull();
    expect(message.focusCalls.length).toBe(0);
  });

  it("does nothing on a page with no line and no search", () => {
    expect(focusLanding(landing({}))).toBeNull();
  });

  it("is loaded on every page", async () => {
    const { app } = buildTestApp();
    const html = parse((await admin(app).get("/tickets")).text);
    const scripts = html.querySelectorAll("script").map((s) => s.getAttribute("src"));
    expect(scripts).toContain("/assets/js/landing.js");
  });
});

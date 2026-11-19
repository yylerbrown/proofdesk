import { describe, expect, it } from "vitest";
import { focusNamedForm, type StartBox } from "../src/browser/landing.js";

// The Status menu's Resolved and In Progress lead to a form the address names, such as
// #resolve-form. The browser scrolls to it but skips autofocus on such a page, so the script
// puts focus on the box the server marked, without scrolling again.

function fakeBox() {
  const calls: { preventScroll: boolean }[] = [];
  const box: StartBox = { focus: (options) => calls.push(options) };
  return { box, calls };
}

describe("a form the address names", () => {
  it("gets focus on its marked box, where the browser already scrolled", () => {
    const { box, calls } = fakeBox();
    expect(focusNamedForm(box, false)).toBe(box);
    expect(calls).toEqual([{ preventScroll: true }]);
  });

  it("leaves focus alone when something already has it", () => {
    const { box, calls } = fakeBox();
    expect(focusNamedForm(box, true)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does nothing when the form has no marked box", () => {
    expect(focusNamedForm(null, false)).toBeNull();
  });
});

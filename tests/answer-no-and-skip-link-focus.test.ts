import { describe, expect, it } from "vitest";
import { focusMain, type MainPart } from "../src/browser/landing.js";
import { inPlace, type InPlaceBox } from "../src/browser/send-label.js";

// Two small moves of keyboard focus. The customer's "No, it is not fixed" opens its box in place:
// focus goes into the box, and the page scrolls only as far as needed to show it. "Skip to main
// content" puts focus on the page's main part for a moment, so the next Tab goes to its first
// control, and main stops taking focus once it moves on.

describe("the No box", () => {
  it("takes focus without the browser's own jump, then scrolls only as far as needed", () => {
    const calls: string[] = [];
    const box: InPlaceBox = {
      focus: (options) => calls.push(`focus preventScroll=${options.preventScroll}`),
      scrollIntoView: (options) => calls.push(`scroll block=${options.block}`),
    };
    inPlace(box).focus();
    expect(calls).toEqual(["focus preventScroll=true", "scroll block=nearest"]);
  });
});

describe("the skip link's landing", () => {
  it("focuses main for a moment and lets it go when focus moves on", () => {
    const attributes = new Map<string, string>();
    let focused = 0;
    let onBlur: () => void = () => undefined;
    const main: MainPart = {
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      focus: () => (focused += 1),
      addEventListener: (_type, listener, options) => {
        expect(options.once).toBe(true);
        onBlur = listener;
      },
    };
    focusMain(main);
    expect(focused).toBe(1);
    expect(attributes.get("tabindex")).toBe("-1");
    onBlur();
    expect(attributes.has("tabindex")).toBe(false);
  });
});

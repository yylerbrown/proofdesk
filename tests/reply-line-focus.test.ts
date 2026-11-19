import { describe, expect, it } from "vitest";
import { focusBoxWhenOpened, type Fold } from "../src/browser/send-label.js";

// The message line looks like a closed text box. A press opens it and puts the caret in its box.
// A box that opens by itself, with a draft or a refused message shown back, keeps focus where
// the page put it.

/** A stand-in details element and summary that keep their listeners. */
function fakeLine(open: boolean) {
  let onClick: () => void = () => undefined;
  let onToggle: () => void = () => undefined;
  const fold: Fold = { open, addEventListener: (_type, given) => (onToggle = given) };
  const button = { addEventListener: (_type: "click", given: () => void) => (onClick = given) };
  const box = { focused: 0, focus: () => (box.focused += 1) };
  focusBoxWhenOpened(fold, button, box);
  return {
    fold,
    box,
    // A press: the click comes first, then the details element opens or closes.
    press: () => {
      onClick();
      fold.open = !fold.open;
      onToggle();
    },
    openByItself: () => {
      fold.open = true;
      onToggle();
    },
  };
}

describe("pressing the message line", () => {
  it("puts the caret in the box when it opens", () => {
    const line = fakeLine(false);
    line.press();
    expect(line.fold.open).toBe(true);
    expect(line.box.focused).toBe(1);
  });

  it("leaves focus alone when the press closes it", () => {
    const line = fakeLine(true);
    line.press();
    expect(line.fold.open).toBe(false);
    expect(line.box.focused).toBe(0);
  });

  it("leaves focus alone when the box opens without a press", () => {
    const line = fakeLine(false);
    line.openByItself();
    expect(line.box.focused).toBe(0);
  });
});

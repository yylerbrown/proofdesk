import { describe, expect, it } from "vitest";
import { selectedWords, wireBulk, type TickBox } from "../src/browser/bulk.js";

// The script behind the ticket list's bar: it shows the bar only while something is ticked,
// counts what is, and ticks or clears every row from one box.

function box(checked = false) {
  const listeners: (() => void)[] = [];
  const made: TickBox & { change(to: boolean): void } = {
    checked,
    indeterminate: false,
    hidden: true,
    addEventListener: (_type, listener) => listeners.push(listener),
    change(to) {
      made.checked = to;
      for (const listener of listeners) listener();
    },
  };
  return made;
}

function page(keepOpen = false) {
  const rows = [box(), box(), box()];
  const all = box();
  const bar = { hidden: false };
  const phone = { hidden: true };
  const count = { textContent: "" as string | null };
  const pressed: (() => void)[] = [];
  const clear = {
    addEventListener: (_type: "click", listener: () => void) => pressed.push(listener),
    press: () => pressed.forEach((listener) => listener()),
  };
  wireBulk({ rows, all: [all], bar, reveal: [phone], count, clear, keepOpen });
  return { rows, all, bar, phone, count, clear };
}

describe("the ticket list's bar", () => {
  it("hides until a row is ticked, then counts the ticked rows", () => {
    const { rows, bar, count } = page();
    expect(bar.hidden).toBe(true);
    rows[0]!.change(true);
    expect(bar.hidden).toBe(false);
    expect(count.textContent).toBe("1 selected");
    rows[2]!.change(true);
    expect(count.textContent).toBe("2 selected");
    rows[0]!.change(false);
    rows[2]!.change(false);
    expect(bar.hidden).toBe(true);
  });

  it("ticks and clears every row from the box that ticks them all", () => {
    const { rows, all, phone, count } = page();
    expect(all.hidden).toBe(false);
    expect(phone.hidden).toBe(false);
    all.change(true);
    expect(rows.every((row) => row.checked)).toBe(true);
    expect(count.textContent).toBe("3 selected");
    rows[1]!.change(false);
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    all.change(false);
    expect(rows.some((row) => row.checked)).toBe(false);
  });

  it("unticks every row and hides again when Clear is pressed", () => {
    const { rows, all, bar, clear } = page();
    all.change(true);
    expect(bar.hidden).toBe(false);
    clear.press();
    expect(rows.some((row) => row.checked)).toBe(false);
    expect(all.checked).toBe(false);
    expect(bar.hidden).toBe(true);
  });

  it("stays shown when it came back with an error", () => {
    expect(page(true).bar.hidden).toBe(false);
    expect(selectedWords(0)).toBe("Change the ticked tickets:");
  });
});

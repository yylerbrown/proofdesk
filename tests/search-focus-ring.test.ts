import fs from "node:fs";
import { describe, expect, it } from "vitest";

// The list's search box and its button join into one pill. Focus rings the whole pill, so the
// ring follows its round ends instead of drawing a square around half of it.

/** The declarations of the one rule with exactly this selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (found === null) throw new Error(`No rule for ${selector}`);
  return found[1]!;
}

describe("the list's search box focus", () => {
  it("rings the whole pill and marks the focused control by its edge", () => {
    const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const pill = rule(css, "form.list-search:has(:focus-visible)");
    expect(pill).toContain("outline: 2px solid var(--pd-focus)");
    const control = rule(css, "form.list-search :is(input, button):focus-visible");
    expect(control).toContain("outline: none");
    expect(control).toContain("border-color: var(--pd-focus)");
  });
});

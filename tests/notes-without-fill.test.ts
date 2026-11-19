import fs from "node:fs";
import { describe, expect, it } from "vitest";

// An internal note keeps a quiet mark that the customer does not see it: a thin amber rule on its
// left and its small label. Neither the note in the conversation nor the reply box in note mode
// is filled with colour.

/** The declarations of the one rule with exactly this selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (found === null) throw new Error(`No rule for ${selector}`);
  return found[1]!;
}

const css = fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("internal notes", () => {
  it("are marked by a thin rule, never a filled block", () => {
    const note = rule(css, "article.entry.note");
    expect(note).toContain("border-left: 2px solid var(--pd-note-bar)");
    expect(note).not.toMatch(/background/);
    const box = rule(css, 'form.reply-box:has(input[value="note"]:checked) textarea');
    expect(box).toContain("border-left: 3px solid var(--pd-note-bar)");
    expect(box).not.toMatch(/background/);
    expect(css).not.toContain("--pd-note-bg");
  });
});

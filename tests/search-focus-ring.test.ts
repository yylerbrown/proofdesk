import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { as, buildTestApp, teamActor } from "./helpers.js";

// The list's search is one round box with its search icon and no button: pressing Enter sends a
// form with one text box. Focus draws the one ring every control has, which follows the round
// ends, with no halo, blue edge or group shadow that could draw a second line or a square.

/** The declarations of the one rule with exactly this selector. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (found === null) throw new Error(`No rule for ${selector}`);
  return found[1]!;
}

const stylesheet = () =>
  fs.readFileSync("public/site.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the list's search box", () => {
  it("is one box with nothing else to press", async () => {
    const { app } = buildTestApp();
    const html = parse((await as(app, teamActor).get("/tickets")).text);
    const form = html.querySelector("form.list-search")!;
    expect(form.querySelectorAll("button, input[type=submit]")).toHaveLength(0);
    const shown = form.querySelectorAll("input").filter((i) => i.getAttribute("type") !== "hidden");
    expect(shown.map((i) => i.getAttribute("type"))).toEqual(["search"]);
  });

  it("draws one ring around the round box when focused, and nothing else", () => {
    const css = stylesheet();
    const focus = rule(css, "form.list-search input:is(:focus, :focus-visible)");
    expect(focus).toContain("outline: 2px solid var(--pd-focus)");
    expect(focus).toContain("box-shadow: none");
    expect(focus).toContain("border-color: var(--pico-form-element-border-color)");
    expect(rule(css, "form.list-search")).toContain(
      "--pico-group-box-shadow-focus-with-input: none",
    );
    expect(css).not.toContain("form.list-search:has(:focus-visible)");
  });
});

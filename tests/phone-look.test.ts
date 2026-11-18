import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { buildTestApp, visitor } from "./helpers.js";

// Small things about the look that a browser test would be slow to reach: what the demo strip
// says, a select that keeps inside the side panel, decoration screen readers skip, GitHub's mark
// in forced colours, and buttons marked aria-disabled drawn like disabled ones. The sizes on a
// phone are measured in a real browser in tests/browser/phone.spec.ts.

describe("the demo strip", () => {
  it("says the demo is shared and resets itself about once a day", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const html = parse((await visitor(app).get("/sign-in")).text);
    expect(html.querySelector(".demo-strip")?.text).toBe(
      "Demo: sample data, shared with everyone who visits. It resets itself about once a day.",
    );
  });
});

describe("the look", () => {
  const css = fs.readFileSync("public/site.css", "utf8");

  it("keeps a select in the ticket's side panel inside its card", () => {
    expect(css).toMatch(/\.ticket-panel select \{[^}]*max-width: 100%;/);
  });

  it("gives the welcome page's arrow an empty alternative, after a plain fallback", () => {
    expect(css).toMatch(/content: "\\2192";\s*content: "\\2192" \/ "";/);
  });

  it("keeps GitHub's mark visible in forced colours", () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.github-mark \{[^}]*background-color: ButtonText;[^}]*forced-color-adjust: none;/,
    );
  });

  it("draws a button marked aria-disabled like a disabled one, and does not press it", () => {
    expect(css).toMatch(/\[disabled\],\s*\[aria-disabled="true"\]\s*\) \{\s*border-color/);
    expect(css).toMatch(/:active:not\(\s*:disabled,\s*\[aria-disabled="true"\]\s*\)/);
  });
});

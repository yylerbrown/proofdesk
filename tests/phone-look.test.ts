import fs from "node:fs";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { buildTestApp, visitor } from "./helpers.js";

// Small things about the look that a browser test would be slow to reach: what the demo strip
// says, a select that keeps inside the side panel, decoration screen readers skip, GitHub's mark
// in forced colours, buttons marked aria-disabled drawn like disabled ones, and the header on a
// phone. The sizes on a phone are measured in a real browser in tests/browser/phone.spec.ts.

describe("the demo strip", () => {
  it("says in seven words that the demo is sample data shared with every visitor", async () => {
    const { app } = buildTestApp({ DEMO: "on", DEV_SIGN_IN: "off" });
    const html = parse((await visitor(app).get("/sign-in")).text);
    expect(html.querySelector(".demo-strip")?.text).toBe(
      "Demo: sample data, shared with every visitor.",
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

  it("keeps GitHub's and Microsoft's marks visible in forced colours", () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.github-mark,\s*\.microsoft-mark \{[^}]*background-color: ButtonText;[^}]*forced-color-adjust: none;/,
    );
  });

  it("draws a button marked aria-disabled like a disabled one, and does not press it", () => {
    expect(css).toMatch(/\[disabled\],\s*\[aria-disabled="true"\]\s*\) \{\s*border-color/);
    expect(css).toMatch(/:active:not\(\s*:disabled,\s*\[aria-disabled="true"\]\s*\)/);
  });

  it("keeps the header on one row on a phone, cutting a long name short", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
    expect(phone).toMatch(/\.site-header nav \{[^}]*flex-wrap: nowrap/);
    expect(phone).toMatch(/\.person-menu > summary strong,[^{]*\{[^}]*text-overflow: ellipsis/);
  });
});

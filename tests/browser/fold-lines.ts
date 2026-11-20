import { expect, type Page } from "@playwright/test";

// Shared by the browser tests: every fold-open line reads as one thing to press. Its chevron
// follows its words with the same small gap, the whole line shows a pointer, and the line is
// only as wide as its words and chevron, so the focus ring wraps them together. The closed
// message box, drawn as a text box, is left out.

/** Each fold-open line on the page: its words, how far its box reaches past them, its cursor. */
export async function foldLines(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("details:not(.dropdown) > summary:not([role])")]
      .filter((summary) => !summary.closest("details.reply-fold:not([open])"))
      .filter((summary) => summary.getBoundingClientRect().width > 0)
      .map((summary) => {
        const box = summary.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(summary);
        const wordsRight = Math.max(...[...range.getClientRects()].map((rect) => rect.right));
        return {
          words: summary.textContent!.trim(),
          pastWords: Math.round(box.right - wordsRight),
          cursor: getComputedStyle(summary).cursor,
        };
      }),
  );
}

export function expectOneLook(lines: Awaited<ReturnType<typeof foldLines>>) {
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    // The chevron is about 14 pixels wide and 2 pixels after the words.
    expect(line.pastWords, line.words).toBeGreaterThanOrEqual(12);
    expect(line.pastWords, line.words).toBeLessThanOrEqual(20);
    expect(line.cursor, line.words).toBe("pointer");
  }
}

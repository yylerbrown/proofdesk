// A text box with a limit shows how many characters it holds once the text nears the limit, and
// how far over it is past it, so a long paste is never cut off or refused unnoticed. The box has
// no maxlength, so the browser keeps the whole paste and the server says what is wrong.

/** The parts of the text box this code reads. */
export type CountedBox = {
  value: string;
  dataset: { countLimit?: string };
  addEventListener(type: "input", listener: () => void): void;
};

/** The line that shows the count. */
export type CountLine = { textContent: string | null; hidden: boolean | string };

/** The count shows from this share of the limit on. */
export const SHOW_FROM = 0.9;

/** How many characters the text counts as: each line break once, no spaces at the ends. */
export function countedLength(text: string): number {
  return text.replace(/\r\n?/g, "\n").trim().length;
}

/** The words for this many characters against this limit, or null while it is far below it. */
export function countWords(count: number, limit: number): string | null {
  if (count < limit * SHOW_FROM) return null;
  const words = `${count.toLocaleString("en")} of ${limit.toLocaleString("en")} characters`;
  if (count <= limit) return `${words}.`;
  return `${words}, ${(count - limit).toLocaleString("en")} over.`;
}

/** Keeps the line under one box up to date as the person types or pastes. */
export function wireCount(box: CountedBox, line: CountLine) {
  const limit = Number(box.dataset.countLimit);
  if (!Number.isInteger(limit) || limit <= 0) return;
  const update = () => {
    const words = countWords(countedLength(box.value), limit);
    line.hidden = words === null;
    line.textContent = words ?? "";
  };
  box.addEventListener("input", update);
  // A form drawn again after a refusal may already hold long text.
  update();
}

if (typeof document !== "undefined") {
  // The description's box and the title's one-line box.
  const boxes = document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
    "textarea[data-count-limit], input[data-count-limit]",
  );
  for (const box of boxes) {
    const line = document.getElementById(box.dataset.countInto ?? "");
    if (line !== null) wireCount(box, line);
  }
}

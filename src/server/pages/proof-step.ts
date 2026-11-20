import type { CheckSuggestion } from "../tickets/suggested-checks.js";

// The second step of filing: the customer says what would prove the ticket is fixed. It is a
// small form on the ticket page, in the place the check takes once it is saved. Each suggested
// way is a "+" button that adds its words to the one box; the box is the only thing saved.

/**
 * The three ways to prove the demo's sample is fixed. They are fixed sample text, written here,
 * and never stored suggestions or the words of any assistant.
 */
export const SAMPLE_PROOFS = [
  "I export this month's report and the file has every row.",
  "The exported file has as many rows as the report shows on screen.",
  "I open the exported file and see this month's figures, not only the header row.",
] as const;

/** One suggestion above the box, drawn as a "+" button that adds its words to the box. */
export type ProofChoice = {
  words: string;
  /** True when the box holds these words now: the button shows a check in place of the "+". */
  added: boolean;
};

/** Text with plain line breaks and no space at either end, as the box is compared. */
function plain(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

/** True when the box holds these words, alone or among other words. */
export function inBox(box: string, words: string): boolean {
  return plain(words) !== "" && plain(box).includes(plain(words));
}

/**
 * The box after a suggestion's "+" is pressed: the words alone in an empty box, otherwise on a
 * new line after what is there. Words already in the box are not added again.
 */
export function addToBox(box: string, words: string): string {
  if (plain(words) === "" || inBox(box, words)) return box;
  const before = box.replace(/\s+$/, "");
  return before === "" ? plain(words) : `${before}\n${plain(words)}`;
}

/** The suggestions the step offers: those still offered, at most three, in their order. */
function shownSuggestions(offered: CheckSuggestion[]): CheckSuggestion[] {
  return offered.filter((suggestion) => suggestion.state === "offered").slice(0, 3);
}

/** The suggestions above the box: the sample's three on the demo's sample, or else those offered. */
export function proofChoices(
  sample: boolean,
  offered: CheckSuggestion[],
  boxWords: string,
): ProofChoice[] {
  const words = sample
    ? [...SAMPLE_PROOFS]
    : shownSuggestions(offered).map((suggestion) => suggestion.words);
  return words.map((choice) => ({ words: choice, added: inBox(boxWords, choice) }));
}

/**
 * The suggestion a saved box started from: the first one shown whose words are still in the
 * box, or undefined when none is.
 */
export function firstInBox(
  offered: CheckSuggestion[],
  boxWords: string,
): CheckSuggestion | undefined {
  return shownSuggestions(offered).find((suggestion) => inBox(boxWords, suggestion.words));
}

/**
 * The team's one grey line while suggestions wait for the customer, or null when none wait.
 */
export function waitingLine(offeredCount: number): string | null {
  if (offeredCount <= 0) return null;
  const ways = offeredCount === 1 ? "1 way" : `${offeredCount} ways`;
  return `The assistant suggested ${ways} to prove it. The customer has not picked one.`;
}

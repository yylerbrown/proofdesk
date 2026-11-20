import type { CheckSuggestion } from "../tickets/suggested-checks.js";
import { sameText } from "../tickets/schemas.js";

// The second step of filing: the customer says what would prove the ticket is fixed. It is a
// small form on the ticket page, in the place the check takes once it is saved. Suggested ways
// fill its one box; the box is the only thing saved.

/**
 * The three ways to prove the demo's sample is fixed. They are fixed sample text, written here,
 * and never stored suggestions or the words of any assistant.
 */
export const SAMPLE_PROOFS = [
  "I export this month's report and the file has every row.",
  "The exported file has as many rows as the report shows on screen.",
  "I open the exported file and see this month's figures, not only the header row.",
] as const;

/** One choice above the box: a stored suggestion by its id, or a sample by its place. */
export type ProofChoice = {
  /** The form field the choice is sent as, with scripts off. */
  name: "suggestion_id" | "sample_choice";
  value: string;
  words: string;
  /** True when the box holds these words now. */
  checked: boolean;
};

/** The choices above the box: the sample's three on the demo's sample, or else those offered. */
export function proofChoices(
  sample: boolean,
  offered: CheckSuggestion[],
  boxWords: string,
): ProofChoice[] {
  const choices: Omit<ProofChoice, "checked">[] = sample
    ? SAMPLE_PROOFS.map((words, index) => ({
        name: "sample_choice",
        value: String(index),
        words,
      }))
    : offered
        .filter((suggestion) => suggestion.state === "offered")
        .slice(0, 3)
        .map((suggestion) => ({
          name: "suggestion_id",
          value: String(suggestion.id),
          words: suggestion.words,
        }));
  return choices.map((choice) => ({
    ...choice,
    checked: boxWords.trim() !== "" && sameText(choice.words, boxWords.trim()),
  }));
}

/**
 * The words a sample choice sends when the box was left empty, as a page with scripts off may
 * send it, or undefined when it names no sample.
 */
export function sampleWords(choice: unknown): string | undefined {
  if (typeof choice !== "string" || !/^[0-2]$/.test(choice)) return undefined;
  return SAMPLE_PROOFS[Number(choice)];
}

/**
 * The team's one grey line while suggestions wait for the customer, or null when none wait.
 */
export function waitingLine(offeredCount: number): string | null {
  if (offeredCount <= 0) return null;
  const ways = offeredCount === 1 ? "1 way" : `${offeredCount} ways`;
  return `The assistant suggested ${ways} to prove it. The customer has not picked one.`;
}

import { createTicketSchema } from "../tickets/schemas.js";

// The ticket form's description has a limit. The box shows a count as the text nears it, and a
// refused form says how far over the text was, so a long paste is never cut off unnoticed.

/** The most characters a ticket's description may hold, read from the service's own rule. */
export const DESCRIPTION_LIMIT = createTicketSchema.shape.description.maxLength ?? 5000;

/**
 * How many characters a box's text counts as: each line break once, and no spaces at the ends,
 * the way the service reads it before it checks the limit.
 */
export function countedLength(text: string): number {
  return text.replace(/\r\n?/g, "\n").trim().length;
}

/**
 * The form's messages, with one more sentence under the description when its text is over the
 * limit, saying by how much. The other messages stay as they are.
 */
export function withHowFarOver(
  errors: Record<string, string[] | undefined>,
  description: string,
): Record<string, string[] | undefined> {
  const over = countedLength(description) - DESCRIPTION_LIMIT;
  if (errors.description === undefined || over <= 0) return errors;
  const sentence = `It is ${over.toLocaleString("en")} ${over === 1 ? "character" : "characters"} over.`;
  return { ...errors, description: [...errors.description, sentence] };
}

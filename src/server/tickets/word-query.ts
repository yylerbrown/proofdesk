// Turning typed text into words, and words into a query for the ticket_search word index.
//
// The index matches words with their endings folded: "signing" finds "sign in" and "phones"
// finds "phone". It does not know synonyms: "login" does not find "sign in".

/**
 * Small words that say nothing about a ticket, including the pieces an apostrophe leaves
 * ("doesn't" splits into "doesn" and "t"). A search leaves them out, so "sign in on my phone"
 * looks for "sign" and "phone".
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "after",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "cannot",
  "cant",
  "could",
  "did",
  "didn",
  "do",
  "does",
  "doesn",
  "don",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "isn",
  "it",
  "its",
  "ll",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "re",
  "s",
  "so",
  "t",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "this",
  "to",
  "too",
  "us",
  "ve",
  "was",
  "wasn",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "won",
  "would",
  "you",
  "your",
]);

/**
 * Words that nearly every support ticket holds, so sharing them does not make two tickets alike.
 * The list search still looks for them; comparing two titles leaves them out.
 */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  "again",
  "broken",
  "error",
  "help",
  "issue",
  "please",
  "problem",
  "still",
  "work",
  "working",
  "works",
  "wrong",
]);

/** The most words one search or one title comparison looks for. */
export const MOST_WORDS = 8;

// A ticket key such as SUP-4: letters, a hyphen, digits.
const KEY_FORM = /^[a-z]+-\d+$/i;

/** The words of a text: runs of letters and digits, lower-cased, in the order they appear. */
export function splitWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Each word once, in the order of first appearance. */
function distinct(words: string[]): string[] {
  return [...new Set(words)];
}

/**
 * One word as the index reads it: inside double quotes, so nothing typed can become query
 * syntax. A word holds only letters and digits, so it never holds a quote itself.
 */
function quoted(word: string): string {
  return `"${word}"`;
}

/**
 * The words a list search looks for: those of two characters or more that are not function
 * words, each once, at most eight.
 */
export function searchWords(q: string): string[] {
  const words = splitWords(q).filter((word) => word.length >= 2 && !FUNCTION_WORDS.has(word));
  return distinct(words).slice(0, MOST_WORDS);
}

/**
 * The query the list search gives the word index, or null when the search is a plain text search
 * only. Every word must be in the ticket, in any order and any form. The last word also finds
 * longer words that start with it ("pass" finds "password"), when it has three characters or more:
 * a shorter start finds almost everything.
 *
 * Null when no word is left, or when the search has the form of a ticket key, so a key that does
 * not open a ticket stays a plain search.
 */
export function listSearchMatch(q: string): string | null {
  if (KEY_FORM.test(q.trim())) return null;
  const words = searchWords(q);
  if (words.length === 0) return null;
  const terms = words.map(quoted);
  const last = words[words.length - 1]!;
  if (last.length >= 3) terms[terms.length - 1] = `${quoted(last)}*`;
  return terms.join(" AND ");
}

/**
 * The words that make a title what it is, for comparing it with other titles: words of three
 * letters or more, or numbers of two digits or more, that are in neither list above, each once,
 * at most eight.
 */
export function titleWords(title: string): string[] {
  const words = splitWords(title).filter((word) => {
    if (FUNCTION_WORDS.has(word) || FILLER_WORDS.has(word)) return false;
    return /^\d+$/.test(word) ? word.length >= 2 : word.length >= 3;
  });
  return distinct(words).slice(0, MOST_WORDS);
}
